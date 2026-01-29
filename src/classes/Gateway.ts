import {
  decode as msgpackDecode,
  encode as msgpackEncode
} from '@msgpack/msgpack';
// @ts-ignore ipc-client is lacking typing... fix this
import IPC, { type IPCMessage } from 'ipc-client';
import { EventEmitter } from 'tseep';
import {
  type Client,
  CloseCodes,
  type DecodedMessage,
  type EncodingType,
  OPCodes,
  type Presence,
  type RawUser,
  type User,
  type WebSocketData
} from '../constants';
import { generateSnowflake } from '../snowflake';

export class Gateway extends EventEmitter<{
  ready: () => void;
  'ipc.connect': () => void;
  'ipc.disconnect': () => void;
}> {
  server: Bun.Server<WebSocketData> | undefined;
  ipc: IPC;
  clients: Client[];
  eventBufferSweepInterval: NodeJS.Timeout | undefined;

  constructor() {
    super();

    this.clients = [];

    // Configure event buffer sweep interval:
    // Every 5 minutes, this will sweep the event buffer, and clear buffered events
    // that are more than 90 seconds old. As a client can only resume at a max of
    // 60 seconds after a disconnect, once an event is over 60 seconds old it won't
    // ever need to be re-sent again, theoretically.
    this.eventBufferSweepInterval = setInterval(
      () => {
        this.clients.forEach((client) => {
          if (!client.eventBuffer.length) return;

          client.eventBuffer.forEach((event, index) => {
            if (Date.now() - event.timestamp >= 90 * 1000)
              client.eventBuffer.splice(index, 1);
          });
        });
      },
      5 * (60 * 1000)
    );

    // Configure IPC:
    // This allows the Gateway to talk to & listen for messages from
    // the REST API or any other processes
    this.ipc = new IPC('gateway');

    this.ipc.on('connect', () => this.emit('ipc.connect'));
    this.ipc.on('disconnect', () => this.emit('ipc.disconnect'));

    this.ipc.on('message', (message: IPCMessage) =>
      this.handleIPCMessage(message)
    );
  }

  /**
   * Handles a new connection opening
   * @param ws Connection socket
   */
  handleConnectionOpen(ws: Bun.ServerWebSocket<WebSocketData>) {
    // Determine connection encoding type
    if (!ws.data.url) return ws.close(CloseCodes.UNKNOWN);

    const params = new URLSearchParams(ws.data.url.split('?')[1]);
    let encoding: EncodingType | undefined;

    if (!params || !params.get('encoding')) encoding = 'json' as EncodingType;
    else encoding = params.get('encoding') as EncodingType;

    if (!encoding) return ws.close(CloseCodes.UNKNOWN);
    if (!['json', 'msgpack'].includes(encoding))
      return ws.close(CloseCodes.INVALID_ENCODING);

    // Generate a session ID, heartbeat interval and jitter
    // and add to the client list
    const id = generateSnowflake();
    const interval = 45 * 1000;
    const jitter = Math.random();

    const client: Client = {
      id,
      socket: ws,
      encoding,
      status: 'unauthenticated',
      seq: 0,
      eventBuffer: [],
      heartbeat: {
        interval,
        lastReceived: undefined,
        timeout: undefined
      },
      identity: {
        id: undefined,
        presence: null,
        timeout: undefined,
        resumeTimeout: undefined
      },
      relations: []
    };

    ws.data.id = id;

    this.clients.push(client);

    // Start timeouts
    client.heartbeat.timeout = setTimeout(() => {
      ws.close(CloseCodes.SESSION_TIMED_OUT);
    }, 60 * 1000);

    client.identity.timeout = setTimeout(() => {
      ws.close(CloseCodes.IDENTIFY_TIMED_OUT);
    }, 60 * 1000);

    // Send HELLO
    ws.send(
      this.encodeMessage(encoding, {
        op: OPCodes.HELLO,
        dt: {
          interval,
          jitter
        }
      })
    );
  }

  /**
   * Handles a connection closing
   * @param ws Connection socket
   * @param code WebSocket close code
   * @param message WebSocket close message
   */
  async handleConnectionClose(
    ws: Bun.ServerWebSocket<WebSocketData>,
    code: number,
    _message: string
  ) {
    const client = this.getClient(ws.data.id);
    if (!client) throw 'Client not found';

    // Kill timeouts
    clearTimeout(client.heartbeat.timeout);
    clearTimeout(client.identity.timeout);

    client.heartbeat.timeout = undefined;
    client.identity.timeout = undefined;

    // Intentional close
    if (code === CloseCodes.NORMAL_CLOSURE || code === CloseCodes.GOING_AWAY) {
      // Broadcast presence update to related clients
      if (
        client.status === 'authenticated' &&
        typeof client.identity.id === 'string'
      ) {
        const clients = this.clients.filter((i) => {
          return (
            i.status === 'authenticated' &&
            i.relations.includes(client.identity.id ?? '') &&
            i.identity.id !== client.identity.id
          );
        });

        if (clients.length > 0)
          await Promise.all(
            clients.map(async (i) => {
              this.sendEventToClient(i.socket, 'PRESENCE_UPDATE', {
                userId: client.identity.id,
                oldPresence: client.identity.presence,
                newPresence: {
                  status: 'offline',
                  text: null
                }
              });
            })
          );
      }

      // Remove client from client list
      this.deleteClient(client.id);
    }

    // Unintentional close
    else {
      // Set resume timeout
      client.identity.resumeTimeout = setTimeout(async () => {
        // Broadcast presence update to related clients
        if (
          client.status === 'authenticated' &&
          typeof client.identity.id === 'string'
        ) {
          const clients = this.clients.filter(
            (i) =>
              i.status === 'authenticated' &&
              i.relations.includes(client.identity.id ?? '') &&
              i.identity.id !== client.identity.id
          );

          if (clients.length > 0)
            await Promise.all(
              clients.map(async (i) => {
                this.sendEventToClient(i.socket, 'PRESENCE_UPDATE', {
                  userId: client.identity.id,
                  oldPresence: client.identity.presence,
                  newPresence: null
                });
              })
            );
        }

        // Remove client from client list
        this.deleteClient(client.id);
      }, 62 * 1000);
    }
  }

  /**
   * Handles a message from a connection
   * @param ws Connection socket
   * @param encoded Encoded incoming message data
   */
  async handleMessage(
    ws: Bun.ServerWebSocket<WebSocketData>,
    encoded: string | Buffer<ArrayBufferLike>
  ) {
    const client = this.getClient(ws.data.id);
    if (!client) throw 'Client not found';

    try {
      // Decode & validate message
      const message = this.decodeMessage(client.encoding, encoded);

      if (!message) return ws.close(CloseCodes.UNKNOWN);
      if (message.op === undefined) return ws.close(CloseCodes.INVALID_PAYLOAD);

      // EVENT
      if (message.op === OPCodes.EVENT) {
        if (client.status !== 'authenticated')
          return ws.close(CloseCodes.NOT_AUTHENTICATED);

        if (!message.ev) return ws.close(CloseCodes.INVALID_PAYLOAD);

        // PRESENCE_UPDATE
        if (message.ev === 'PRESENCE_UPDATE') {
          if (!message.dt) return ws.close(CloseCodes.INVALID_PAYLOAD);

          if (message.dt.status && typeof message.dt.status !== 'string')
            return ws.send(
              this.encodeMessage(client.encoding, {
                op: OPCodes.ERROR,
                dt: {
                  code: 10014, // TODO: error numbers/docs
                  message: 'Invalid payload'
                }
              })
            );

          if (message.dt.text && (typeof message.dt.text !== 'string' && message.dt.text !== null))
            return ws.send(
              this.encodeMessage(client.encoding, {
                op: OPCodes.ERROR,
                dt: {
                  code: 10015, // TODO: error numbers/docs
                  message: 'Invalid payload'
                }
              })
            );

          const oldPresence: Presence | null = client.identity.presence;

          const newPresence: Presence = {
            status: message.dt.status,
            text: message.dt.text
          };

          // Broadcast to related clients
          const clients = this.clients.filter(
            (i) =>
              i.status === 'authenticated' &&
              i.relations.includes(client.identity.id ?? '')
          );

          if (clients.length > 0)
            await Promise.all(
              clients.map(async (i) => {
                this.sendEventToClient(i.socket, 'PRESENCE_UPDATE', {
                  userId: client.identity.id,
                  oldPresence,
                  newPresence
                });
              })
            );

          // Send to this client as well
          this.sendEventToClient(ws, 'PRESENCE_UPDATE', {
            userId: client.identity.id,
            oldPresence,
            newPresence
          });
        }
      }

      // IDENTIFY
      if (message.op === OPCodes.IDENTIFY) {
        if (!message.dt) return ws.close(CloseCodes.INVALID_PAYLOAD);
        if (!message.dt.token) return ws.close(CloseCodes.INVALID_PAYLOAD);

        if (client.status === 'authenticated')
          return ws.close(CloseCodes.ALREADY_AUTHENTICATED);

        // Cancel identify timeout
        clearTimeout(client.identity.timeout);
        client.identity.timeout = undefined;

        // Validate token/auth
        if (message.dt.token.startsWith('Bearer '))
          message.dt.token = message.dt.token.split(' ')[1];

        const { valid, userId } = await this.verifyToken(
          // @ts-ignore this does exist, it is confirmed at the start of the func.
          message.dt.token.startsWith('Bearer ') ? message.dt.token.split(' ')[1] : message.dt.token
        );

        if (!valid || userId === null)
          return ws.close(CloseCodes.INVALID_AUTHENTICATION);

        // Fetch initial data to send
        const users = await this.fetchUserData(userId);

        // Set client data
        client.status = 'authenticated';
        client.relations = users.map(({ id }) => id);
        client.identity.id = userId;
        client.identity.presence = {
          status: message.dt?.presence ? message.dt.presence.status : 'online',
          text: message.dt?.presence ? message.dt.presence.text : null
        };

        // Send READY
        ws.send(
          this.encodeMessage(client.encoding, {
            op: OPCodes.READY,
            dt: {
              id: client.id,
              users
            }
          })
        );

        // Send presence update to clients
        const clients = this.clients.filter(
          (client) =>
            client.status === 'authenticated' &&
            client.relations.includes(userId) &&
            client.identity.id !== userId
        );

        if (clients.length > 0)
          await Promise.all(
            clients.map(async (client) => {
              this.sendEventToClient(client.socket, 'PRESENCE_UPDATE', {
                userId,
                oldPresence: null,
                newPresence: {
                  status: message.dt?.presence
                    ? message.dt.presence.status
                    : 'online',
                  text: message.dt?.presence ? message.dt.presence.text : null
                }
              });
            })
          );
      }

      // HEARTBEAT
      if (message.op === OPCodes.HEARTBEAT) {
        // End timeout
        clearTimeout(client.heartbeat.timeout);

        client.heartbeat.timeout = undefined;
        client.heartbeat.lastReceived = Date.now();

        // Acknowledge heartbeat
        ws.send(
          this.encodeMessage(client.encoding, {
            op: OPCodes.HEARTBEAT_ACK
          })
        );

        // Restart timeout
        client.heartbeat.timeout = setTimeout(() => {
          ws.close(CloseCodes.SESSION_TIMED_OUT);
        }, 60 * 1000);
      }

      // RESUME
      if (message.op === OPCodes.RESUME) {
        if (client.status === 'authenticated')
          return ws.close(CloseCodes.ALREADY_AUTHENTICATED);

        if (!message.dt) return ws.close(CloseCodes.INVALID_PAYLOAD);
        if (
          !message.dt.id ||
          message.dt.seq === undefined ||
          message.dt.seq < 0
        )
          return ws.close(CloseCodes.INVALID_PAYLOAD);

        // Try and find old client/session
        // (if not found, reconnection period has expired)
        const previousClient = this.getClient(message.dt.id);
        if (!previousClient) return ws.close(CloseCodes.RESUME_TIMED_OUT);

        // End the reconnection timeout & the new client's identify timeout
        clearTimeout(previousClient.identity.resumeTimeout);
        clearTimeout(client.identity.timeout);

        previousClient.identity.resumeTimeout = undefined;
        client.identity.timeout = undefined;

        // Transfer old client data to new one
        client.identity = {
          id: previousClient.identity.id,
          presence: previousClient.identity.presence,
          timeout: undefined,
          resumeTimeout: undefined
        };

        // Re-send all missed events using the provided sequence
        await Promise.all(
          previousClient.eventBuffer.map(async (event) => {
            if (!message.dt || message.dt.seq === undefined) return false;

            if (event.seq >= message.dt.seq) {
              ws.send(
                this.encodeMessage(client.encoding, {
                  op: OPCodes.EVENT,
                  ev: event.event,
                  dt: event.payload,
                  seq: event.seq
                })
              );

              return true;
            } else return false;
          })
        );

        // Delete old client
        this.deleteClient(previousClient.id);

        // Set new client as authenticated and send RESUMED
        client.status = 'authenticated';

        ws.send(
          this.encodeMessage(client.encoding, {
            op: OPCodes.RESUMED,
            dt: {
              id: client.id
            }
          })
        );
      }
    } catch (error) {
      console.error(error);

      return ws.close(CloseCodes.DECODE_ERROR);
    }
  }

  /**
   * Handles a message from the IPC server/socket
   * @param message IPC message data
   */
  async handleIPCMessage(message: IPCMessage) {
    const type = message.payload.type as string;

    if (type === 'event') {
      const {
        type: _type,
        event,
        client: clientId,
        ...payload
      }: {
        type: string;
        event: string;
        client: string;
        [key: string]: unknown;
      } = message.payload;

      // Handle "broadcast" type events separately
      // TODO: only add this in when adding user update events? don't know what crack i was on but presence update ain't one lmao
      /*if (['PRESENCE_UPDATE'].includes(event)) {
        // Find all the clients to send to, based off user relations
        const clients = this.clients.filter((client) =>
          client.status === 'authenticated'
          && client.relations.includes(clientId)
          && client.identity.id !== clientId
        );

        if (clients.length <= 0) return;

        // Modify payload, if required
        let modifiedPayload: any = payload;

        if (event === 'PRESENCE_UPDATE') {
          const client = this.clients.find((client) =>
            client.status === 'authenticated'
            && client.identity.id === clientId
          );
          
          modifiedPayload = {
            userId: payload.userId,
            oldPresence: client?.identity.presence,
            newPresence: payload.presence
          }
        }

        // Send event to each client
        await Promise.all(
          clients.map(async (client) => {
            this.sendEventToClient(client.socket, event, modifiedPayload);
          })
        );
      }*/

      // Find who to send the event to
      const client = this.clients.find(
        (client) =>
          client.status === 'authenticated' && client.identity.id === clientId
      );

      if (!client) return;

      // Send event
      this.sendEventToClient(client.socket, event, payload);

      // Hook into certain events to keep relations up to date for the Gateway
      if (['FRIEND_CREATE'].includes(event)) {
        if (!client.relations.includes(payload.userId as string))
          client.relations.push(payload.userId as string);
      }

      if (['FRIEND_DELETE'].includes(event)) {
        const index = client.relations.findIndex(
          (id) => id === (payload.userId as string)
        );

        if (index === -1) return;

        client.relations.splice(index, 1);
      }
    }
  }

  /**
   * Start the Gateway server
   */
  serve() {
    this.server = Bun.serve({
      fetch(req, server) {
        const upgraded = server.upgrade(req, {
          data: {
            url: req.url,
            id: ''
          }
        });

        if (upgraded) return undefined;

        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        open: (ws: Bun.ServerWebSocket<WebSocketData>) => {
          this.handleConnectionOpen(ws);
        },
        close: (ws, code, message) => {
          this.handleConnectionClose(ws, code, message);
        },
        message: (ws, message) => {
          this.handleMessage(ws, message);
        }
      }
    });

    this.emit('ready');
  }

  /**
   * Get the client data from session ID
   * @param id Session ID
   * @returns Client data
   */
  getClient(id: string): Client | undefined {
    return this.clients.find((i) => i.id === id);
  }

  /**
   * Delete client data
   * @param id Session ID
   */
  deleteClient(id: string): void {
    const index = this.clients.findIndex((i) => i.id === id);

    this.clients.splice(index, 1);
  }

  /**
   * Helper to send an OP 0 EVENT to a client. Handles event buffer and session sequence.
   * @param ws Client socket
   * @param event Event to send (enum)
   * @param data Optional payload data
   */
  sendEventToClient(
    ws: Bun.ServerWebSocket<WebSocketData>,
    event: string,
    data?: unknown
  ) {
    const client = this.getClient(ws.data.id);
    if (!client) throw 'Client not found';

    // Increment sequence
    client.seq++;

    // Send event
    ws.send(
      this.encodeMessage(client.encoding, {
        op: OPCodes.EVENT,
        ev: event,
        seq: client.seq,
        dt: data || undefined
      })
    );

    // Push event to event buffer
    client.eventBuffer.push({
      seq: client.seq,
      timestamp: Date.now(),
      event,
      payload: data
    });
  }

  /**
   * Encode outgoing message data
   * @param type Encoding type
   * @param message Message data to encode
   * @returns Encoded message data
   */
  encodeMessage(type: EncodingType, message: unknown) {
    let encoded: string | Uint8Array | undefined;

    if (type === 'json') encoded = JSON.stringify(message);
    else if (type === 'msgpack') encoded = msgpackEncode(message);
    else throw 'Unknown encoding type';

    return encoded;
  }

  /**
   * Decode incoming message data
   * @param type Encoding type
   * @param message Message data to decode
   * @returns Decoded message data
   */
  decodeMessage(type: EncodingType, message: unknown) {
    let decoded: DecodedMessage | undefined;

    if (type === 'json') decoded = JSON.parse(message as string);
    else if (type === 'msgpack')
      decoded = msgpackDecode(
        new Uint8Array(message as Uint8Array)
      ) as DecodedMessage;
    else throw 'Unknown encoding type';

    return decoded;
  }

  /**
   * Verify token used for authentication
   * @param token Token to verify
   * @returns Boolean indicating if token is valid
   */
  verifyToken(
    token: string
  ): Promise<{ valid: boolean; userId: string | null }> {
    return new Promise((resolve, _reject) => {
      this.ipc.on('message', (message: IPCMessage) => {
        if (
          message.from === 'rest' &&
          'type' in message.payload &&
          (message.payload.type as string) === 'response' &&
          'token' in message.payload &&
          (message.payload.token as string) === token &&
          'valid' in message.payload &&
          'userId' in message.payload
        )
          return resolve({
            valid: message.payload.valid as boolean,
            userId: message.payload.userId as string | null
          });
      });

      this.ipc.send('rest', {
        type: 'request',
        action: 'VERIFY_TOKEN',
        token
      });
    });
  }

  /**
   * Fetch initial user data
   * @param userId ID of user to fetch data for
   * @returns Array of user objects
   */
  fetchUserData(userId: string): Promise<User[]> {
    return new Promise((resolve, _reject) => {
      this.ipc.on('message', (message: IPCMessage) => {
        if (
          message.from === 'rest' &&
          'type' in message.payload &&
          (message.payload.type as string) === 'response' &&
          'userId' in message.payload &&
          (message.payload.userId as string) === userId &&
          'data' in message.payload
        ) {
          // Determine and add presence data by finding client
          const data: User[] = (message.payload.data as RawUser[]).map(
            (user) => {
              const client = this.clients.find(
                (client) =>
                  client.status === 'authenticated' &&
                  client.identity.id === user.id
              );

              const defaultPresence: Presence = {
                status: 'offline',
                text: null
              };

              if (!client)
                return {
                  presence: defaultPresence,
                  ...user
                };

              return {
                presence:
                  client.identity.presence === null
                    ? defaultPresence
                    : client.identity.presence,
                ...user
              };
            }
          );

          return resolve(data);
        }
      });

      this.ipc.send('rest', {
        type: 'request',
        action: 'FETCH_USER_DATA',
        userId
      });
    });
  }
}

// Enums
export enum OPCodes {
  EVENT = 0,
  HELLO = 1,
  IDENTIFY = 2,
  READY = 3,
  HEARTBEAT = 4,
  HEARTBEAT_ACK = 5,
  RESUME = 6,
  RESUMED = 7,
  ERROR = 8
}

export enum CloseCodes {
  NORMAL_CLOSURE = 1000,
  GOING_AWAY = 1001,

  UNKNOWN = 4000,
  INVALID_ENCODING = 4001,
  INVALID_PAYLOAD = 4002,
  DECODE_ERROR = 4003,
  RATE_LIMITED = 4004,
  NOT_AUTHENTICATED = 4005,
  INVALID_AUTHENTICATION = 4006,
  ALREADY_AUTHENTICATED = 4007,
  SESSION_TIMED_OUT = 4008,
  IDENTIFY_TIMED_OUT = 4009,
  RESUME_TIMED_OUT = 4010
}

// Types
export type WebSocketData = {
  url: string;
  id: string;
};

export type EncodingType = 'json' | 'msgpack';

export type AuthenticationType = 'unauthenticated' | 'authenticated';

// Interfaces
export interface Client {
  id: string;
  socket: Bun.ServerWebSocket<WebSocketData>;
  encoding: EncodingType;
  status: AuthenticationType;
  seq: number;
  eventBuffer: BufferedEvent[];
  heartbeat: ClientHeartbeat;
  identity: ClientIdentity;
  relations: string[];
}

export interface ClientHeartbeat {
  interval: number;
  lastReceived: number | undefined;
  timeout: NodeJS.Timeout | undefined;
}

export interface ClientIdentity {
  id: string | undefined;
  presence: Presence | null;
  timeout: NodeJS.Timeout | undefined;
  resumeTimeout: NodeJS.Timeout | undefined;
}

export interface DecodedMessage {
  op: number;
  ev?: string;
  seq?: number;
  dt?: DecodedMessageData;
}

export interface DecodedMessageData {
  // OP 0 EVENT
  // - PRESENCE_UPDATE
  status: 'online' | 'away' | 'dnd' | 'offline';
  text: string | null;

  // OP 2 IDENTIFY
  token?: string;
  presence?: Presence;

  // OP 6 RESUME
  id?: string;
  seq?: number;
}

export interface OutgoingMessage {
  op: number;
  ev?: string;
  seq?: number;
  dt?: unknown;
}

export interface BufferedEvent {
  seq: number;
  timestamp: number;
  event: string;
  payload: unknown;
}

export interface RawUser {
  id: string;
  username: string;
}

export interface User extends RawUser {
  presence: Presence;
}

export interface Presence {
  status: 'online' | 'away' | 'dnd' | 'offline';
  text: string | null;
}

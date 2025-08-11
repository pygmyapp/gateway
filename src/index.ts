import { Gateway } from './classes/Gateway';

const gateway = new Gateway();

// Gateway
gateway.on('ready', () =>
  console.log(`Gateway started on port ${gateway.server.port}`)
);

gateway.serve();

// IPC
gateway.on('ipc.connect', () => console.log('Connected to IPC server/socket'));

gateway.on('ipc.disconnect', () =>
  console.log('Lost connection to IPC server/socket')
);

gateway.ipc.connect();
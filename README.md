# 🐰💬 pygmyapp/gateway
WebSocket server for real-time communication and events

## Dependencies
**Pygmy is built with Bun!** It doesn't run on node.js alone, [see here to install Bun](https://bun.com/docs/installation) or [here to learn more](https://bun.sh).

`pygmyapp/gateway` depends on:
- an active IPC server (`pygmyapp/ipc-server`), used for authentication
- an active REST API (`pygmyapp/rest`), used for reacting to REST events when they occur

## Install

### Docker

If you are using Docker, you can clone this repository and run:

```sh
docker compose build # build image

docker compose up # start image
```

### Manual

- Clone this repository
- Install dependencies with `bun install`
- Copy `.env.example` to `.env` and configure environment variables

You can then start in production/dev mode:
```sh
bun run prod # production

bun run dev # dev mode - reloads on file changes
```

## Scripts

- `bun run lint`: runs Biome linting, applies safe fixes, and auto-organizes imports

## Licence
Copyright (c) 2025 Pygmy & contributors

All code & assets are licensed under GNU GPL v3 unless stated otherwise.  
See `LICENSE` or [see here](https://www.gnu.org/licenses/gpl-3.0.txt).
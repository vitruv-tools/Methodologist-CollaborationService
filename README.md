# Methodologist-CollaborationService

Real-time collaboration server for the Vitruv Methodologist: syncs project edits between users with [Yjs](https://yjs.dev) over WebSockets and writes them back to the backend.

Design: [vitruv-tools/Vitruv-UI-Methodologist#635](https://github.com/vitruv-tools/Vitruv-UI-Methodologist/issues/635)

**Status:** in development. The server shares documents between clients, but doesn't check access yet and doesn't load from or write back to the backend. Don't deploy it publicly yet: anyone could join any room.

## How it works

- Clients connect over WebSocket with the [y-websocket](https://github.com/yjs/y-websocket) protocol (`WebsocketProvider` in the browser).
- The URL path names the room: `ws://localhost:1234/vsum:12` joins the room `vsum:12`. Everyone in a room shares one Yjs document.
- Documents are kept in memory only.
- `GET /health` returns `200` with `{"status":"UP"}`.

## Requirements

- Node.js 20 (see `.nvmrc`; with nvm: `nvm use`)
- npm

## Run locally

```bash
npm ci
npm run dev        # starts the server with reload on changes, on port 1234
```

The server reads its settings from environment variables (see `.env.example`), e.g. `PORT=4000 npm run dev`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `1234` | Port for HTTP and WebSocket connections |

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs `src/index.ts` with reload on changes |
| `npm run build` | Compiles TypeScript into `dist/` |
| `npm start` | Runs the compiled server (`dist/index.js`) |
| `npm test` | Runs the tests (`npm test -- --coverage` for coverage) |
| `npm run typecheck` | Type-checks sources and tests |

## Docker

```bash
docker build -t collaboration-service .
docker run -p 1234:1234 collaboration-service
curl http://localhost:1234/health
```

## Notes

- **y-websocket version:** the server part comes from `y-websocket@2` (`y-websocket/bin/utils`). Newer releases moved it into `@y/websocket-server`, whose current version depends on the Yjs 14 beta, while the clients use Yjs 13.
- **LevelDB warnings during `npm ci`:** y-websocket has an optional LevelDB persistence that this server doesn't use. Its native module may print warnings or fail to build on some machines (e.g. Apple Silicon); that doesn't affect the server.
- **Adding dependencies:** npm 10 can crash with `Cannot read properties of null (reading 'edgesOut')` when resolving Vitest's peer dependencies. `npm ci` works; to add or update packages, use npm 11 (`npx npm@11 install <package>`).

# Methodologist-CollaborationService

Real-time collaboration server for the Vitruv Methodologist: syncs project edits between users with [Yjs](https://yjs.dev) over WebSockets and writes them back to the backend.

Design: [vitruv-tools/Vitruv-UI-Methodologist#635](https://github.com/vitruv-tools/Vitruv-UI-Methodologist/issues/635)

**Status:** in development. The server checks access, loads projects from the backend, writes changes back, reloads projects the backend changed and closes projects the backend removed. The frontend doesn't use it yet.

## How it works

- Clients connect over WebSocket with the [y-websocket](https://github.com/yjs/y-websocket) protocol (`WebsocketProvider` in the browser).
- The URL path names the room: `ws://localhost:1234/vsum:12` joins the room `vsum:12`. Everyone in a room shares one Yjs document.
- Before a connection is accepted, the backend is asked for the user's role in the project (`GET /api/v1/vsums/{id}/details` with the user's token). Viewers can read but not change the document.
- When the first user opens a project, the server loads it from the backend (`GET /api/internal/v1/vsums/{id}/details` with its own service account) into the room's document. Connections are accepted once that's done. If loading fails, the connection is rejected and that empty document is never written back; the next connection tries loading again.
- Changes are written back automatically (`PUT /api/internal/v1/vsums/{id}/sync-changes`): 5 seconds after the last change, at the latest every 60 seconds, when the last user leaves and when the server stops. Each writeback sends the complete state; Postgres stays the source of truth. A failed writeback keeps the changes and is reported in the document's `status.writebackError`. It is retried with a growing delay if the backend failed or didn't answer; otherwise (e.g. `400`), it is tried again after the next change and when the last user leaves. An element the server can't read is reported the same way instead of being written back.
- When the backend changes a project outside the document (version restore, `LinkMetaModelsPanel`, metamodel renames and ecore saves), it calls `POST /internal/projects/{id}/reload` with the token of its service account. The server checks the token against Keycloak's public keys (issuer `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}`, realm role `methodologist-backend`) and answers `401` for a missing, invalid or expired token, `403` without the role, `400` for an invalid project ID and otherwise `202`. For an open project, it pauses the room's writeback right away, waits for a writeback that is already running, loads the project and applies only the differences to the document, so connected clients see the change without reconnecting. The backend wins: changes made in the document that weren't written back yet are dropped. If loading fails, it is retried with a growing delay, and nothing is written back until it succeeds. A project nobody has open needs nothing; a room nobody uses anymore is dropped.
- When a project is moved to the trash or deleted, the backend calls `POST /internal/projects/{id}/close`, whose token is checked the same way. For an open project, the server first asks the backend whether it still has the project (`GET /api/internal/v1/vsums/{id}/details`). Only if that answers `404` does it drop the room, without writing it back (changes that weren't written back are lost), and close its connections with code `4410`. A notification that arrives late or twice, e.g. after the project was restored and opened again, leaves the room alone. The server answers `202`, or `503` if the backend couldn't be asked, so the backend sends the notification again. Reconnecting is rejected with `403` until the project is restored from the trash; then the next user loads it into a new room.
- A room is dropped once its last user left and its changes are written back; a room whose changes the backend keeps rejecting stays in memory until a user fixes them or the server stops. Documents are kept in memory only, so changes from the last seconds before a crash are lost.
- The document's layout (metamodels, relations, views, positions, status) is described in [`src/document.ts`](src/document.ts).
- `GET /health` returns `200` with `{"status":"UP"}`.

## Requirements

- Node.js 20 (see `.nvmrc`; with nvm: `nvm use`)
- npm

## Run locally

```bash
npm ci
export KEYCLOAK_URL=http://localhost:7668 KEYCLOAK_CLIENT_SECRET=dev-only-collaboration-service-secret
npm run dev        # starts the server with reload on changes, on port 1234
```

The server reads its settings from environment variables (see `.env.example`), e.g. `PORT=4000 npm run dev`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `1234` | Port for HTTP and WebSocket connections |
| `BACKEND_URL` | `http://localhost:9811` | Base URL of the backend |
| `KEYCLOAK_URL` | (required) | Base URL of Keycloak, where the server gets the token of its service account and the keys that check the backend's tokens. Must be the URL the backend gets its token from (the token's issuer), otherwise the backend's reload and close notifications get `401` |
| `KEYCLOAK_REALM` | `methodologist` | Keycloak realm |
| `KEYCLOAK_CLIENT_ID` | `collaboration-service` | Client of the service account |
| `KEYCLOAK_CLIENT_SECRET` | (required) | Secret of that client |

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
docker run -p 1234:1234 -e KEYCLOAK_URL=http://host.docker.internal:7668 \
  -e KEYCLOAK_CLIENT_SECRET=dev-only-collaboration-service-secret collaboration-service
curl http://localhost:1234/health
```

## Known limitations

- **Reaction files of members:** the backend writes the changes back as the project's owner, so it accepts only reaction files the owner uploaded or the project already uses. A reaction file a member uploaded for a new relation is rejected (`404`), which blocks the writeback until the relation is removed. This needs a change in the backend.
- **Soft delete:** soft-deleted elements are left out of the writeback, so the backend deletes them. Restoring a metamodel afterwards adds it again from the model library, without the project's own changes to its Ecore.
- **Fine-granular mappings** are plain JSON, replaced as a whole. If a user changes a relation's mappings at the moment the server adds new IDs to them, one of the two changes is lost.
- **Outdated client documents:** a client that reconnects with its old document after a room was dropped or the server restarted merges it into the newly loaded one (#11).
- **A writeback running when the backend changes a project** can still overwrite that change: the server waits for it before reloading, but can't take it back once it was sent. Preventing that needs the backend, e.g. a version check on `sync-changes`.
- **Changes the backend doesn't announce** are undone by the next writeback, which sends the complete state. The backend notifies only for the changes listed above (vitruv-tools/methodologistUI-backend#425).
- **Rejected changes stay in memory:** a room whose changes the backend keeps rejecting stays until a user fixes them or the server stops; then they are lost.

## Notes

- **y-websocket version:** the server part comes from `y-websocket@2` (`y-websocket/bin/utils`). Newer releases moved it into `@y/websocket-server`, whose current version depends on the Yjs 14 beta, while the clients use Yjs 13.
- **Server code imports Yjs from `src/yjs.ts`, not from `yjs`:** y-websocket's server part is CommonJS and loads Yjs's CommonJS build, while `import 'yjs'` would load its separate ES build. The two copies don't recognize each other's types ("Unexpected content type").
- **LevelDB warnings during `npm ci`:** y-websocket has an optional LevelDB persistence that this server doesn't use. Its native module may print warnings or fail to build on some machines (e.g. Apple Silicon); that doesn't affect the server.
- **Adding dependencies:** npm 10 can crash with `Cannot read properties of null (reading 'edgesOut')` when resolving Vitest's peer dependencies. `npm ci` works; to add or update packages, use npm 11 (`npx npm@11 install <package>`).

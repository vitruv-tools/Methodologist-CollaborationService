import { createRequire } from 'node:module';

/**
 * The Yjs module that y-websocket's server code uses. Server code uses this instead of
 * `import * as Y from 'yjs'`.
 *
 * y-websocket's server part is CommonJS and loads Yjs with `require`, which gives Yjs's CommonJS
 * build. `import 'yjs'` in this ES module would load Yjs's separate ES build. The two copies don't
 * recognize each other's types: setting a `Y.Map` of one copy into a document of the other throws
 * "Unexpected content type", and `instanceof` checks fail.
 */
export const Y = createRequire(import.meta.url)('yjs') as typeof import('yjs');

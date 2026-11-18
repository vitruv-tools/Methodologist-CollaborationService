import { createBackendClient } from './backend.js';
import { loadConfig, type Config } from './config.js';
import { createCollaborationServer } from './server.js';
import { createServiceToken } from './serviceToken.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const backend = createBackendClient({
  backendUrl: config.backendUrl,
  serviceToken: createServiceToken(config.keycloak),
});
const server = createCollaborationServer({ backendUrl: config.backendUrl, backend });

const port = await server.listen(config.port);
console.log(`Collaboration server listening on port ${port}, backend at ${config.backendUrl}`);

// Docker stops containers with SIGTERM: write the changes back and exit instead of waiting to be
// killed. A second signal (e.g. pressing Ctrl+C twice) waits for the same shutdown.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down`);
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Shutdown failed', error);
        process.exit(1);
      },
    );
  });
}

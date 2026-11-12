import { loadConfig, type Config } from './config.js';
import { createCollaborationServer } from './server.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const server = createCollaborationServer({ backendUrl: config.backendUrl });

const port = await server.listen(config.port);
console.log(`Collaboration server listening on port ${port}, backend at ${config.backendUrl}`);

// Docker stops containers with SIGTERM: disconnect the clients and exit instead of waiting to be killed.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`Received ${signal}, shutting down`);
    server.close().finally(() => process.exit(0));
  });
}

import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { createApp } from './app.js';
import { createServices } from './services/index.js';

const config = getConfig();
const { clipboardStore } = createServices({ config });

// Sweep expired clipboard entries so TTL cleanup does not rely on reads alone
// (§8.2). The timer must not keep the process alive on its own.
const purgeTimer = setInterval(() => {
  clipboardStore
    .purgeExpired()
    .catch((error) => console.error('clipboard purge failed:', error));
}, config.clipboard.maintenanceIntervalMs);
purgeTimer.unref();

const server = createServer(createApp({ config }));

server.listen(config.port, () =>
  console.log(`Backend listening on http://localhost:${config.port}`),
);

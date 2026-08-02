import { startServer } from './app.js';

const PORT = Number(process.env.PORT ?? 8799);

await startServer(PORT);
// eslint-disable-next-line no-console
console.log(`Server listening at http://0.0.0.0:${PORT}`);

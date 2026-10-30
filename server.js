import { createGameServer } from './src/app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const publicUrl = process.env.PUBLIC_URL || '';

const game = createGameServer({ publicUrl });
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — closing Word Rush…`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  await game.close();
  clearTimeout(forceExit);
  process.exit(0);
}

game.start(port, host)
  .then((address) => {
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Word Rush is listening on http://localhost:${actualPort}`);
    console.log(`Loaded ${game.dictionary.words.size.toLocaleString()} words.`);
    if (publicUrl) console.log(`Public URL: ${publicUrl}`);
  })
  .catch((error) => {
    console.error('Could not start Word Rush:', error);
    process.exit(1);
  });

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

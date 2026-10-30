import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { loadDictionary } from './game.js';
import { RoomManager, normalizeCode } from './rooms.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const publicDir = path.join(projectRoot, 'public');

export function createGameServer(options = {}) {
  const log = options.log ?? console;
  const dictionary = options.dictionary
    ?? loadDictionary({ dataDir: options.dataDir ?? path.join(projectRoot, 'data') });

  const manager = new RoomManager({
    dictionary,
    log,
    resultDelayMs: options.resultDelayMs,
    offlineRemoveMs: options.offlineRemoveMs,
    hostTransferMs: options.hostTransferMs,
    publicUrl: options.publicUrl ?? process.env.PUBLIC_URL,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; "
      + "img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "script-src 'self'; connect-src 'self' ws: wss:",
    );
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      rooms: manager.rooms.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/api/qr', async (req, res) => {
    const code = normalizeCode(req.query.room);
    const room = manager.rooms.get(code);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    let joinUrl = room.joinUrl;
    if (!/^https?:\/\//.test(joinUrl)) {
      const forwardedProto = String(req.get('x-forwarded-proto') ?? '').split(',')[0].trim();
      const protocol = forwardedProto || req.protocol;
      joinUrl = `${protocol}://${req.get('host')}/?room=${room.code}`;
    }

    try {
      const png = await QRCode.toBuffer(joinUrl, {
        type: 'png',
        width: 360,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#1D2A44', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(png);
    } catch (error) {
      log.error?.('Could not create QR code:', error);
      res.status(500).json({ error: 'Could not create QR code' });
    }
  });

  app.get('/r/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    res.redirect(302, `/?room=${code}`);
  });

  app.use(express.static(publicDir, {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.woff2')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || path.extname(req.path)) {
      res.status(404).send('Not found');
      return;
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    manager.attach(ws, { origin: req.headers.origin });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      manager.handleMessage(ws, data);
    });

    ws.on('close', () => {
      manager.disconnect(ws);
    });

    ws.on('error', (error) => {
      log.warn?.('WebSocket error:', error?.message ?? error);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  const start = (port = 3000, host = '0.0.0.0') => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      manager.shutdown();
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    })();
    return closing;
  };

  return {
    app,
    server,
    wss,
    manager,
    dictionary,
    start,
    close,
  };
}

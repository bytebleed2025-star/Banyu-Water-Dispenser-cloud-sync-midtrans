'use strict';

/**
 * Recipe B - local cloud half.
 *
 * Serves the online dashboard (cloud/dist) and the Vercel-style API
 * (api/main.js) on one port. MongoDB:
 *   - default: an in-memory MongoDB is started automatically (no install,
 *     resets when this process stops);
 *   - set MONGODB_URI (Atlas / local mongod) to use a real database.
 *
 * The machine server (banyu/server.js) pushes orders/alerts here through
 * /api/ingest with SYNC_SECRET. This process never talks to the ESP.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CLOUD_PORT || 4000);
const DIST = path.join(ROOT, 'cloud', 'dist');

function loadEnvFile(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* optional */ }
}

loadEnvFile(path.join(ROOT, 'banyu', 'settings.env'));
loadEnvFile(path.join(__dirname, '.env'));

process.env.MONGODB_DB = process.env.MONGODB_DB || 'banyu';
process.env.SYNC_SECRET = process.env.SYNC_SECRET || 'trial-sync-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEYWORDS || 'banyu123';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve({}); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

let mongod = null;
let server = null;

async function main() {
  if (!process.env.MONGODB_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    console.log('[mongo] no MONGODB_URI: starting an in-memory MongoDB.');
    console.log('[mongo] the first run downloads a ~100 MB binary; later runs are fast.');
    mongod = await MongoMemoryServer.create({ instance: { dbName: 'banyu' } });
    process.env.MONGODB_URI = mongod.getUri('banyu');
    console.log('[mongo] ready (data lives until this window is closed).');
  } else {
    console.log('[mongo] using MONGODB_URI from the environment.');
  }

  execFileSync(process.execPath, [path.join(ROOT, 'cloud', 'build.js')], { stdio: 'inherit' });
  const handler = require(path.join(ROOT, 'api', 'main.js'));

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        req.query = Object.fromEntries(url.searchParams);
        req.query.route = url.pathname.replace(/^\/api\/?/, '').replace(/^\/+|\/+$/g, '');
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          req.body = await readBody(req);
        }
        await handler(req, res);
        return;
      }

      if (url.pathname === '/') {
        res.writeHead(302, { Location: '/dashboard.html' });
        return res.end();
      }

      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(DIST, rel);
      if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('[dev]', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server error' }));
      }
    }
  });

  server.listen(PORT, () => {
    const admin = String(process.env.ADMIN_PASSWORD).split(',')[0].trim();
    console.log('');
    console.log('=====================================================');
    console.log(' Banyu cloud dashboard (Recipe B, local)');
    console.log(`  Dashboard : http://localhost:${PORT}/dashboard.html`);
    console.log(`  Login     : ${admin}`);
    console.log(`  Mongo     : ${mongod ? 'in-memory (temporary)' : process.env.MONGODB_URI}`);
    console.log(' Keep this window open. Ctrl+C stops the cloud copy.');
    console.log('=====================================================');
  });
}

async function shutdown() {
  try { if (server) server.close(); } catch (_) {}
  try { if (mongod) await mongod.stop(); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(async (e) => {
  console.error('[startup]', e.message);
  await shutdown();
});

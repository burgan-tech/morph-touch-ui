import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, extname } from 'path';

const PORT = 3000;
const API_TARGET = 'http://localhost:4201';
const MATRIX_TARGET = 'http://localhost:9080';
const DIST_DIR = resolve(import.meta.dirname, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const target = `${API_TARGET}${url.pathname}${url.search}`;
    try {
      const proxyRes = await fetch(target, {
        method: req.method,
        headers: { ...req.headers, host: new URL(API_TARGET).host },
        body: ['POST', 'PUT', 'PATCH'].includes(req.method)
          ? await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); })
          : undefined,
      });
      res.writeHead(proxyRes.status, { 'Content-Type': proxyRes.headers.get('content-type') || 'application/json' });
      res.end(await proxyRes.text());
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API unreachable' }));
    }
    return;
  }

  if (req.url.startsWith('/_matrix/')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const target = `${MATRIX_TARGET}${url.pathname}${url.search}`;
    try {
      const proxyRes = await fetch(target, {
        method: req.method,
        headers: { ...req.headers, host: new URL(MATRIX_TARGET).host },
        body: ['POST', 'PUT', 'PATCH'].includes(req.method)
          ? await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); })
          : undefined,
      });
      res.writeHead(proxyRes.status, { 'Content-Type': proxyRes.headers.get('content-type') || 'application/json' });
      res.end(await proxyRes.text());
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Matrix gateway unreachable' }));
    }
    return;
  }

  let filePath = resolve(DIST_DIR, req.url === '/' ? 'index.html' : req.url.slice(1));
  const ext = extname(filePath);
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    const html = readFileSync(resolve(DIST_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
}).listen(PORT, () => console.log(`Wealth App server running at http://localhost:${PORT}`));

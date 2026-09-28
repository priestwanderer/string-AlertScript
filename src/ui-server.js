import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const WEB_ROOT = new URL('../web/', import.meta.url);
const FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/vendor/vue.global.prod.js', 'vendor/vue.global.prod.js']
]);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('请求体不是有效 JSON');
  }
}

export function serveUi({ host = '127.0.0.1', port = 8787, loadConfig, saveConfig, listGroups, checkOnce, scheduleStatus, setSchedule }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, await loadConfig());
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const saved = await saveConfig(await readJson(req));
        sendJson(res, 200, saved);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/groups') {
        const groups = await listGroups(await readJson(req));
        sendJson(res, 200, { groups });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/check') {
        sendJson(res, 200, await checkOnce());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/schedule') {
        sendJson(res, 200, await scheduleStatus());
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/schedule') {
        const body = await readJson(req);
        sendJson(res, 200, await setSchedule(Boolean(body?.enabled)));
        return;
      }

      const relative = FILES.get(url.pathname);
      if (req.method === 'GET' && relative) {
        const fileUrl = new URL(relative, WEB_ROOT);
        const body = await readFile(fileUrl);
        const type = relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': body.length,
          'Cache-Control': 'no-store'
        });
        res.end(body);
        return;
      }

      sendJson(res, 404, { message: '未找到' });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { message: error.message || '请求失败' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actualPort = server.address().port;
      resolve({ server, address: `http://${host}:${actualPort}` });
    });
  });
}

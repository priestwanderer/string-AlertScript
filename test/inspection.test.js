import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('collector preserves percent units and upstream timestamps through batch and fallback requests', { timeout: 15000 }, async (t) => {
  // A separate copy cannot read the real .env, config, or notification state.
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'string-alert-inspection-'));
  let child;
  let upstream;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    if (upstream?.listening) await close(upstream);
    assert.equal(dirname(root), tempRoot);
    assert.ok(basename(root).startsWith('string-alert-inspection-'));
    await rm(root, { recursive: true, force: true });
  });
  await cp(new URL('../src/', import.meta.url), join(root, 'src'), { recursive: true });
  await cp(new URL('../package.json', import.meta.url), join(root, 'package.json'));

  const account = { id: 269, name: 'demo', platform: 'openai', type: 'oauth', status: 'active', groups: [{ id: 1, name: 'primary' }] };
  let utilization = 1;
  let timestamp = '2026-09-29T02:00:00.000Z';
  let fallback = false;
  let usageResponseAt = 0;
  const requests = [];
  upstream = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ path, body });
    let data;
    if (path === '/api/v1/auth/login') data = { access_token: 'test-only-token' };
    else if (path === '/api/v1/admin/accounts') data = { items: [account], total: 1 };
    else if (path === '/api/v1/admin/groups/all') data = [{ id: 1, name: 'primary' }];
    else if (path === '/api/v1/admin/accounts/usage/batch' || path === '/api/v1/admin/accounts/269/usage') {
      if (fallback && path.endsWith('/batch')) {
        res.writeHead(404).end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      usageResponseAt = Date.now();
      const usage = { updated_at: timestamp, five_hour: { utilization: 0, remaining_seconds: 0 }, seven_day: { utilization, window_stats: { cost: 5.4068 } } };
      data = path.endsWith('/batch') ? { usage: { 269: usage }, errors: {} } : usage;
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const uiPort = await listen(reservation);
  await close(reservation);

  child = spawn(process.execPath, ['src/index.js', '--ui'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, UI_HOST: '127.0.0.1', UI_PORT: String(uiPort), UI_BASE_PATH: '',
      SUB2API_SERVERS: 'fixture', SUB2API_SERVER_FIXTURE_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      SUB2API_SERVER_FIXTURE_EMAIL: 'test@example.invalid', SUB2API_SERVER_FIXTURE_PASSWORD: 'test-only',
      SUB2API_SERVER_FIXTURE_ENABLED: 'true', SUB2API_SERVER_FIXTURE_GROUP_SCOPE: 'all',
      SUB2API_SERVER_FIXTURE_MONITOR_ALL_ACCOUNTS: 'true', SUB2API_SERVER_FIXTURE_ESTIMATED_COST_THRESHOLD: '500',
      QUOTA_REMAIN_PERCENT: '20', WECOM_WEBHOOK_URL: `http://127.0.0.1:${upstreamPort}/webhook`
    }
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`UI startup timed out: ${output}`)), 6000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`UI exited: ${output}`)); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`http://127.0.0.1:${uiPort}`)) { clearTimeout(timer); resolve(); }
    });
  });
  async function snapshot() {
    const response = await fetch(`http://127.0.0.1:${uiPort}/api/monitor?server=fixture`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.server.error, null);
    assert.ok(Date.parse(body.generatedAt) >= usageResponseAt, 'collection timestamp must follow the usage response');
    return body.server;
  }
  const healthy = await snapshot();
  assert.equal(healthy.urgentAccountCount, 0);
  assert.equal(healthy.all, null);
  assert.deepEqual(healthy.groups, []);
  assert.equal(healthy.usageUpdatedAt, timestamp);
  assert.equal(healthy.usageTimestampMissingCount, 0);

  utilization = 100;
  const depleted = await snapshot();
  assert.equal(depleted.urgentAccountCount, 1);
  assert.deepEqual(depleted.groups[0].accounts[0].windows, [{ windowName: '7d', remainingPercent: 0 }]);
  assert.equal(depleted.groups[0].accounts[0].usageUpdatedAt, timestamp);

  timestamp = null;
  const unknown = await snapshot();
  assert.equal(unknown.usageUpdatedAt, null);
  assert.equal(unknown.usageTimestampMissingCount, 1);

  fallback = true;
  utilization = 1;
  const single = await snapshot();
  assert.equal(single.urgentAccountCount, 0);
  assert.equal(single.all, null);
  assert.deepEqual(single.groups, []);
  assert.ok(requests.some(({ path }) => path.endsWith('/269/usage')));
  for (const { body } of requests.filter(({ path }) => path.endsWith('/usage/batch'))) {
    assert.deepEqual(body, { account_ids: [269], force: false });
  }
  assert.equal(requests.some(({ path }) => path === '/webhook'), false);
});

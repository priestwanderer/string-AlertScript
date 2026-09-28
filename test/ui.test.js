import test from 'node:test';
import assert from 'node:assert/strict';
import { serveUi } from '../src/ui-server.js';

test('config page and local API are served', async () => {
  const saved = [];
  const seenServers = [];
  const { server, address } = await serveUi({
    host: '127.0.0.1',
    port: 0,
    loadConfig: async () => ({ webhookUrl: 'https://example.invalid/hook', monitorAllAccounts: false, servers: [] }),
    saveConfig: async (input) => {
      saved.push(input);
      return input;
    },
    listGroups: async () => [{ id: 3, name: 'rotation', platform: 'openai' }]
    ,
    checkOnce: async () => ({ sent: 1, failures: [], summary: '已推送 1 条告警' }),
    scheduleStatus: async () => ({ enabled: false, running: false }),
    setSchedule: async (enabled) => ({ enabled, running: false }),
    monitorSnapshot: async (serverId) => {
      seenServers.push(serverId ?? '');
      return serverId
        ? { generatedAt: '2026-09-28T00:00:00.000Z', server: { id: serverId, groups: [] } }
        : { generatedAt: '2026-09-28T00:00:00.000Z', servers: [] };
    }
  });

  try {
    const page = await fetch(`${address}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /全账号总余额告警/);
    assert.match(html, /指定分组/);
    assert.match(html, /告警一次/);
    assert.match(html, /定时告警/);
    assert.match(html, /监控/);
    assert.match(html, /配置/);
    assert.match(html, /刷新/);
    assert.match(html, /没有余额不足/);
    assert.match(html, /不足分组/);
    assert.match(html, /告急账号/);
    assert.match(html, /\/api\/monitor/);
    assert.match(html, /\/api\/monitor\?server=/);
    assert.match(html, /MONITOR_REFRESH_MS = 30000/);
    assert.match(html, /已使用/);
    assert.match(html, /监控概览/);
    assert.match(html, /monitor-stack/);
    assert.match(html, /仅看异常/);
    assert.match(html, /搜索服务器、分组或账号/);
    assert.match(html, /aria-expanded/);
    assert.match(html, /刷新监控不会发送告警/);
    assert.match(html, /sk-shimmer/);
    assert.match(html, /总余额阈值[\s\S]*USD/);
    assert.match(html, /单账号剩余[\s\S]*%/);
    assert.match(html, /静默时间[\s\S]*分钟/);
    assert.match(html, /定时告警[\s\S]*检查间隔[\s\S]*分钟/);
    assert.match(html, /\/vendor\/vue\.global\.prod\.js/);

    const script = await fetch(`${address}/vendor/vue.global.prod.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /Vue/);

    const styles = await fetch(`${address}/monitor.css`);
    assert.match(styles.headers.get('content-type'), /text\/css/);
    const css = await styles.text();
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /\.secret input\[type="password"\]::-ms-reveal\s*\{\s*display:\s*none;/);
    const helpers = await fetch(`${address}/monitor-view.js`);
    assert.match(helpers.headers.get('content-type'), /javascript/);
    assert.match(await helpers.text(), /export function summarizeCards/);
    const icons = await fetch(`${address}/vendor/lucide-sprite.svg`);
    assert.match(icons.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await icons.text(), /id="server"/);

    const config = await fetch(`${address}/api/config`);
    assert.equal((await config.json()).monitorAllAccounts, false);

    const groups = await fetch(`${address}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://10.0.0.1' })
    });
    assert.equal((await groups.json()).groups[0].name, 'rotation');

    const update = await fetch(`${address}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitorAllAccounts: true })
    });
    assert.equal(update.status, 200);
    assert.equal(saved[0].monitorAllAccounts, true);

    const check = await fetch(`${address}/api/check`, { method: 'POST' });
    assert.equal((await check.json()).summary, '已推送 1 条告警');
    const schedule = await fetch(`${address}/api/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal((await schedule.json()).enabled, true);
    const monitor = await fetch(`${address}/api/monitor`);
    assert.equal(monitor.status, 200);
    assert.deepEqual((await monitor.json()).servers, []);
    const one = await fetch(`${address}/api/monitor?server=japan`);
    assert.equal(one.status, 200);
    assert.equal((await one.json()).server.id, 'japan');
    assert.deepEqual(seenServers, ['', 'japan']);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

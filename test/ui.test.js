import test from 'node:test';
import assert from 'node:assert/strict';
import { serveUi } from '../src/ui-server.js';

test('config page and local API are served', async () => {
  const saved = [];
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
    setSchedule: async (enabled) => ({ enabled, running: false })
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
    assert.match(html, /总余额阈值[\s\S]*USD/);
    assert.match(html, /单账号剩余[\s\S]*%/);
    assert.match(html, /静默时间[\s\S]*分钟/);
    assert.match(html, /定时告警[\s\S]*检查间隔[\s\S]*分钟/);
    assert.match(html, /\/vendor\/vue\.global\.prod\.js/);

    const script = await fetch(`${address}/vendor/vue.global.prod.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /Vue/);

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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

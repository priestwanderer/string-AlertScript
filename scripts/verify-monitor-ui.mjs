import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openPreview, previewViews, previewConfig } from './preview-ui.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.env.UI_SCREENSHOT_DIR || '.ui-check');
await mkdir(out, { recursive: true });
const { server, address } = await openPreview(0, process.env.UI_TEST_BASE_PATH || '');
let browser;

try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const errors = [];
  const mutations = [];
  const remoteRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutations.push(request.url());
    if (!request.url().startsWith(address)) remoteRequests.push(request.url());
  });
  await page.goto(`${address}/`);
  await page.locator('.monitor-account').nth(3).waitFor();
  assert.equal(await page.locator('.monitor-server').count(), 2);
  assert.equal(await page.locator('.stat-value').last().innerText(), '4\n个');
  assert.match(await page.locator('.group-columns').first().innerText(), /预计总费用/);
  assert.equal(await page.locator('.account-updated-at').first().getAttribute('title'), await page.evaluate((value) => new Date(value).toLocaleString('zh-CN', { hour12: false }), previewViews.japan.usageUpdatedAt));
  assert.match(await page.locator('.usage-updated-at').first().innerText(), /用量最早更新.*2026/);
  assert.equal(await page.locator('.usage-updated-at').last().innerText(), '用量最早更新 未知');
  assert.equal(await page.locator('.usage-time-missing').first().innerText(), '1 个账号未提供用量时间');
  assert.equal(await page.locator('.window-meter b').nth(1).innerText(), '0.9%');
  const originalUsageTime = await page.locator('.usage-updated-at').first().innerText();
  await page.getByRole('button', { name: '刷新 日本站', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="刷新 日本站"]').disabled);
  assert.equal(await page.locator('.usage-updated-at').first().innerText(), originalUsageTime, 'collection must not replace the upstream timestamp');
  await checkPalette('monitor');
  await page.screenshot({ path: resolve(out, 'monitor-desktop.png'), fullPage: true });

  async function checkPalette(view) {
    const result = await page.evaluate((view) => {
      const rgb = (value) => value.match(/[\d.]+/g).map(Number).slice(0, 3);
      const luminance = (color) => rgb(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const background = (element) => {
        for (let node = element; node; node = node.parentElement) {
          const value = getComputedStyle(node).backgroundColor;
          if (!value.startsWith('rgba(')) return value;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const surfaces = view === 'monitor'
        ? ['.top', '.overview-strip', '.monitor-server', '.monitor-search']
        : ['.top', '.server', '.secret input', '.switch-row'];
      const errors = surfaces.flatMap((selector) => [...document.querySelectorAll(selector)].flatMap((element) => {
        const actual = getComputedStyle(element).backgroundColor;
        return actual === 'rgb(248, 248, 244)' ? [] : [`${selector}: unexpected surface ${actual}`];
      }));
      const text = '.stat-label, .stat-foot, .state-label, .server-subline, .group-columns, .account-columns, .numeric, .group-identity small, .account-identity strong, .window-meter b, .urgent-label, .server-summary, .monitor-footnote, .field > span, .server-id, .unit';
      for (const element of document.querySelectorAll(text)) {
        if (!element.getClientRects().length) continue;
        const foreground = luminance(getComputedStyle(element).color);
        const backing = luminance(background(element));
        const contrast = (Math.max(foreground, backing) + 0.05) / (Math.min(foreground, backing) + 0.05);
        if (contrast < 4.5) errors.push(`${element.className || element.tagName}: contrast ${contrast.toFixed(2)}`);
      }
      return { canvas: getComputedStyle(document.body).backgroundColor, errors };
    }, view);
    assert.equal(result.canvas, 'rgb(241, 241, 236)', `${view}: warm gray page canvas`);
    assert.deepEqual(result.errors, [], `${view}: palette or text contrast issues`);
  }

  async function checkLayout(label) {
    const report = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('.monitor-page *, .top *')].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > window.innerWidth + 1 || box.left < -1);
      }).slice(0, 8).map((element) => element.className?.baseVal ?? element.className)
    }));
    assert.ok(report.scrollWidth <= report.width + 1, `${label}: page overflows ${JSON.stringify(report)}`);
    assert.deepEqual(report.overflow, [], `${label}: overflowing elements`);
  }

  async function checkTypography(label) {
    const problems = await page.evaluate(() => {
      const checks = [
        ['.numeric', 15], ['.account-identity strong', 14],
        ['.window-meter', 13], ['.group-columns', 13], ['.account-columns', 13],
        ['.state-label', 12], ['.server-subline', 12], ['.stat-foot', 12],
        ['.mobile-label', 12], ['.server-summary', 12], ['.monitor-footnote', 12]
      ];
      return checks.flatMap(([selector, minimum]) => [...document.querySelectorAll(selector)].flatMap((element) => {
        if (!element.getClientRects().length) return [];
        const size = parseFloat(getComputedStyle(element).fontSize);
        if (size < minimum) return [`${selector}: ${size}px < ${minimum}px`];
        if (element.scrollWidth > element.clientWidth + 1) return [`${selector}: text is clipped`];
        return [];
      }));
    });
    assert.deepEqual(problems, [], `${label}: typography issues`);
  }

  await checkLayout('desktop');
  await checkTypography('desktop');
  await page.getByRole('button', { name: '美国站', exact: true }).click();
  assert.equal(await page.locator('.monitor-server').count(), 1);
  await page.getByRole('button', { name: /全部服务器/ }).click();
  await page.getByRole('searchbox').fill('workspace-02');
  assert.equal(await page.locator('.monitor-account').count(), 1);
  await page.getByRole('button', { name: '清空搜索' }).click();
  const disclosure = page.getByRole('button', { name: 'OpenAI 主力账号，2 个告急账号' });
  await disclosure.click();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.monitor-account').count(), 2);
  await disclosure.click();
  await page.getByRole('searchbox').fill('no-such-account');
  assert.equal(await page.locator('.monitor-empty').count(), 1);
  await page.getByRole('button', { name: '清除筛选' }).click();

  for (const width of [1024, 834, 820, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await checkLayout(`${width}px`);
    await checkTypography(`${width}px`);
    assert.equal(await page.locator('.data-freshness').first().isVisible(), true, 'freshness stays visible on mobile');
    if (width === 390) await page.screenshot({ path: resolve(out, 'monitor-mobile.png'), fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/monitor?server=us', (route) => route.fulfill({ status: 503, json: { message: '预览：连接暂时不可用' } }));
  await page.getByRole('button', { name: '刷新 美国站', exact: true }).click();
  await page.getByText('刷新失败，保留上次数据').waitFor();
  assert.equal(await page.locator('.monitor-account').count(), 4);
  assert.equal(await page.locator('.monitor-server[data-status="error"]').count(), 1);
  await page.screenshot({ path: resolve(out, 'monitor-stale.png'), fullPage: true });
  await page.unroute('**/api/monitor?server=us');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('刷新失败，保留上次数据').waitFor({ state: 'hidden' });

  await page.route('**/api/monitor?server=us', (route) => route.fulfill({ json: {
    generatedAt: new Date().toISOString(), server: { ...previewViews.us, all: null, groups: [], lowGroupCount: 0, urgentAccountCount: 0 }
  } }));
  await page.getByRole('button', { name: '刷新 美国站', exact: true }).click();
  await page.getByText('当前监控范围内无异常').waitFor();
  await page.getByLabel('仅看异常').check();
  assert.equal(await page.locator('.monitor-server').count(), 1);
  await page.getByLabel('仅看异常').uncheck();
  await page.getByRole('tab', { name: '配置', exact: true }).click();
  await page.getByText('企业微信 Webhook', { exact: true }).waitFor();
  assert.equal(await page.locator('.server-grid > .server').count(), 2);
  await checkPalette('config');
  const secrets = page.locator('.secret');
  for (let index = 0; index < await secrets.count(); index++) {
    const field = secrets.nth(index);
    const input = field.locator('input');
    const toggle = field.locator('button');
    const sample = 'preview-only-secret';
    assert.equal(await toggle.count(), 1);
    await input.pressSequentially(sample);
    assert.equal(await input.getAttribute('type'), 'password');
    if (index === 1) await field.screenshot({ path: resolve(out, 'password-single-reveal.png') });
    await toggle.click();
    assert.equal(await input.getAttribute('type'), 'text');
    assert.equal(await input.inputValue(), sample);
    await toggle.click();
    assert.equal(await input.getAttribute('type'), 'password');
    assert.equal(await input.inputValue(), sample);
    await input.fill('');
  }
  await page.screenshot({ path: resolve(out, 'config-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: resolve(out, 'config-mobile.png'), fullPage: true });
  await page.getByRole('tab', { name: '监控', exact: true }).click();
  await page.unroute('**/api/monitor?server=us');

  await page.route('**/api/config', (route) => route.fulfill({ json: { ...previewConfig, servers: [] } }));
  await page.reload();
  await page.getByText('没有启用监控的服务器', { exact: true }).waitFor();
  assert.equal(await page.locator('.monitor-server').count(), 0);
  await page.unroute('**/api/config');

  await page.route('**/api/monitor?server=*', (route) => route.fulfill({ status: 503, json: { message: '预览：读取失败' } }));
  await page.reload();
  await page.locator('.monitor-server[data-status="error"]').nth(1).waitFor();
  assert.equal(await page.locator('.stat-value').last().innerText(), '--\n个');
  assert.equal(await page.locator('.healthy-state').count(), 0);
  await page.unroute('**/api/monitor?server=*');

  let releaseLoading;
  const loadingGate = new Promise((resolve) => { releaseLoading = resolve; });
  await page.route('**/api/monitor?server=*', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('server');
    await loadingGate;
    const view = structuredClone(previewViews[id]);
    view.groups[0].name = 'Long-group-name-'.repeat(5);
    view.groups[0].accounts[0].name = `${'long-account-name-'.repeat(10)}@example.invalid`;
    view.groups[0].accounts[0].estimatedCost = null;
    await route.fulfill({ json: { generatedAt: new Date().toISOString(), server: view } });
  });
  await page.reload();
  await page.locator('.server-loading').nth(1).waitFor();
  assert.equal(await page.locator('.stat-value').last().innerText(), '--\n个');
  assert.equal(await page.getByRole('button', { name: '刷新中', exact: true }).isDisabled(), true);
  releaseLoading();
  await page.locator('.monitor-account').nth(3).waitFor();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await checkLayout(`long names ${width}px`);
    const overlapping = await page.evaluate(() => [...document.querySelectorAll('.monitor-account')].some((row) => {
      const identity = row.querySelector('.account-identity').getBoundingClientRect();
      const amount = row.querySelector('.account-balance').getBoundingClientRect();
      return identity.right > amount.left + 1 && identity.bottom > amount.top + 1 && identity.top < amount.bottom - 1;
    }));
    assert.equal(overlapping, false, `long account overlaps amounts at ${width}px`);
  }
  assert.equal(await page.locator('.monitor-account .account-balance').first().innerText(), '预计总费用 · USD\n--');
  assert.deepEqual(errors, [], 'browser runtime errors');
  assert.deepEqual(mutations, [], 'unexpected state-changing API calls');
  assert.deepEqual(remoteRequests, [], 'preview must not contact remote services');
  console.log(JSON.stringify({ ok: true, testedWidths: [1440, 1024, 834, 820, 768, 390, 320], runtimeErrors: errors, mutationRequests: mutations, remoteRequests, screenshots: out }));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

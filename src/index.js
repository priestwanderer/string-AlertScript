import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  formatNumber,
  getAccountName,
  getQuotaAlerts,
  getPaginationTotal,
  isMonitorableAccount,
  readGroupCatalog,
  accountListQuery,
  accountListKeepsMembership,
  attachGroupCatalog,
  resolveAccountCost,
  getUsedCost,
  getUsageUpdatedAt,
  resolveMonitoredGroups,
  shouldFetchUsage,
  summarizeGroupCosts,
  unwrapList,
  usageQuery,
  buildServerAlerts,
  buildServerFailureAlert,
  buildMonitorView,
  formatAlertMessage,
  createInspectionGate
} from './logic.js';
import { loadMonitorConfig, saveMonitorConfig } from './config-store.js';
import { serveUi } from './ui-server.js';

const STATE_FILE = new URL('../data/state.json', import.meta.url);

function loadDotEnv() {
  try {
    const text = readFileSync('.env', 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

loadDotEnv();

let config = null;

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    once: args.has('--once'),
    test: args.has('--test'),
    schedule: args.has('--schedule'),
    ui: args.has('--ui')
  };
}

function validateConfig() {
  const missing = [];
  if (!config.webhookUrl) missing.push('WECOM_WEBHOOK_URL');
  missing.push(...missingCredentials());
  if (missing.length > 0) {
    throw new Error(`请先在 .env 中填写：${missing.join('、')}`);
  }
  if (config.checkIntervalMinutes <= 0) {
    throw new Error('CHECK_INTERVAL_MINUTES 必须大于 0');
  }
}

function missingCredentials(servers = config.servers) {
  const missing = [];
  for (const server of servers) {
    if (server.enabled === false) continue;
    if (!server.baseUrl) missing.push(server.settings.baseUrl);
    if (!server.email) missing.push(server.settings.email);
    if (!server.password) missing.push(server.settings.password);
  }
  return missing;
}

async function request(server, path, options = {}, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  try {
    const response = await fetch(`${server.baseUrl}/api/v1${path}`, {
      ...options,
      headers,
      signal: controller.signal
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const detail = typeof body === 'string' ? body : body?.message || body?.detail || '';
      throw new Error(`${options.method || 'GET'} ${path} 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function login(server) {
  const body = await request(server, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password })
  });
  const token = body?.access_token ?? body?.data?.access_token;
  if (!token) throw new Error('登录成功响应中没有 access_token');
  return token;
}

async function getAllAccounts(server, token) {
  const attempts = [
    { status: 'active', lite: true },
    { status: 'active', lite: false },
    { status: '', lite: false }
  ];
  let lastError = null;
  for (const query of attempts) {
    try {
      const accounts = await fetchAccountPages(server, token, query);
      if (query.lite && !accountListKeepsMembership(accounts)) continue;
      return accounts;
    } catch (error) {
      lastError = error;
      if (!isUnsupportedAccountQuery(error)) throw error;
    }
  }
  throw lastError ?? new Error('账号列表获取失败');
}

function isUnsupportedAccountQuery(error) {
  return /返回 HTTP (400|422)\b/.test(String(error?.message || ''));
}

async function fetchAccountPages(server, token, query) {
  const accounts = [];
  for (let page = 1; page <= 1000; page += 1) {
    const payload = await request(server, accountListQuery(page, config.pageSize, query), {}, token);
    const current = unwrapList(payload);
    accounts.push(...current);
    const total = getPaginationTotal(payload);
    if (current.length === 0 || (total !== null && accounts.length >= total) || current.length < config.pageSize) {
      break;
    }
  }
  return accounts;
}

async function loadGroupCatalog(server, token) {
  try {
    return readGroupCatalog(await request(server, '/admin/groups/all?include_inactive=true', {}, token));
  } catch {
    try {
      return readGroupCatalog(await request(server, '/admin/groups/all', {}, token));
    } catch {
      return [];
    }
  }
}

function usageFor(map, accountId) {
  if (!map || typeof map !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(map, accountId)) return map[accountId];
  const key = String(accountId);
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  return undefined;
}

async function loadUsageMap(server, token, accounts) {
  const ids = accounts.map((account) => account.id);
  try {
    const payload = await request(server, '/admin/accounts/usage/batch', {
      method: 'POST',
      body: JSON.stringify({ account_ids: ids, force: false })
    }, token);
    const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : payload;
    if (data?.usage && typeof data.usage === 'object') {
      return {
        usage: data.usage,
        errors: data.errors && typeof data.errors === 'object' ? data.errors : {}
      };
    }
  } catch (error) {
    console.warn(`【${server.name}】批量获取用量失败，改为逐个查询：${error.message}`);
  }

  const usage = {};
  const errors = {};
  for (const account of accounts) {
    try {
      usage[account.id] = await request(
        server,
        `/admin/accounts/${encodeURIComponent(account.id)}/usage${usageQuery(account)}`,
        {},
        token
      );
    } catch (error) {
      errors[account.id] = error.message;
    }
  }
  return { usage, errors };
}

async function inspect(server) {
  const token = await login(server);
  const [listed, catalog] = await Promise.all([
    getAllAccounts(server, token),
    loadGroupCatalog(server, token)
  ]);
  const allAccounts = attachGroupCatalog(listed, catalog).filter(isMonitorableAccount);
  const targets = allAccounts.filter(shouldFetchUsage);
  const loaded = targets.length > 0 ? await loadUsageMap(server, token, targets) : { usage: {}, errors: {} };
  const records = [];
  const missingCost = [];

  for (const account of targets) {
    const usageItem = usageFor(loaded.usage, account.id);
    const fetchFailed = usageItem == null;
    if (fetchFailed) {
      const reason = usageFor(loaded.errors, account.id);
      const detail = typeof reason === 'string' ? reason : reason?.message;
      console.warn(`【${server.name}】获取账号“${getAccountName(account)}”用量失败${detail ? `：${detail}` : ''}`);
    }

    const resolved = resolveAccountCost(account, fetchFailed ? null : usageItem, { fetchFailed });
    if (resolved.missing) {
      missingCost.push(getAccountName(account));
    }

    records.push({
      account,
      estimatedCost: resolved.cost,
      usedCost: usageItem ? getUsedCost(usageItem) : null,
      usageUpdatedAt: getUsageUpdatedAt(usageItem),
      quotaAlerts: usageItem ? getQuotaAlerts(usageItem, account, config.quotaRemainPercent) : []
    });
  }

  if (missingCost.length > 0) {
    throw new Error(`以下账号用量获取失败，无法计算预计总费用：${missingCost.join('、')}`);
  }

  const quotaAlerts = records.flatMap((record) => record.quotaAlerts);
  const groupCosts = summarizeGroupCosts(records, resolveMonitoredGroups(server, records.map((record) => record.account)));
  const allEstimatedCost = records.length > 0 && records.every((record) => Number.isFinite(record.estimatedCost))
    ? records.reduce((sum, record) => sum + record.estimatedCost, 0)
    : null;

  return { allEstimatedCost, groupCosts, quotaAlerts, accountCount: records.length, records };
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeState(state) {
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function shouldSend(alertKey, state, now) {
  const lastSent = Number(state[alertKey] || 0);
  return now - lastSent >= config.cooldownMinutes * 60 * 1000;
}

async function sendWebhook(message) {
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: message } })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errcode) {
    throw new Error(`企微 Webhook 推送失败：HTTP ${response.status}${body?.errmsg ? `，${body.errmsg}` : ''}`);
  }
}

async function run() {
  config = await loadMonitorConfig();
  validateConfig();
  const state = await readState();
  const now = Date.now();
  const pending = [];
  const failures = [];
  const active = [];

  for (const server of config.servers) {
    if (server.enabled === false) {
      console.log(`【${server.name}】监控已关闭，已跳过`);
      continue;
    }
    active.push(server);
  }
  if (active.length === 0) {
    return { sent: 0, failures, summary: '没有启用监控的服务器' };
  }

  for (const server of active) {
    try {
      const result = await inspect(server);
      const groups = result.groupCosts.map((group) => `${group.name} ${formatNumber(group.estimatedCost)}`).join('，') || '无';
      console.log(`【${server.name}】检查完成：${result.accountCount} 个账号，所有账号预计总费用 ${formatNumber(result.allEstimatedCost)}，分组 ${groups}`);
      pending.push(...buildServerAlerts(server, result, config).filter((alert) => shouldSend(alert.key, state, now)));
    } catch (error) {
      failures.push(server.name);
      console.error(`【${server.name}】巡检失败：${error.message}`);
      const alert = buildServerFailureAlert(server, error.message);
      if (shouldSend(alert.key, state, now)) pending.push(alert);
    }
  }

  if (pending.length === 0) {
    console.log('无新告警');
  } else {
    const message = formatAlertMessage(pending);
    await sendWebhook(message);
    for (const alert of pending) state[alert.key] = now;
    await writeState(state);
    console.log(`已推送 ${pending.length} 条告警`);
  }

  return {
    sent: pending.length,
    failures,
    summary: pending.length === 0 ? '无新告警' : `已推送 ${pending.length} 条告警`
  };
}

let scheduleEnabled = false;
let scheduleToken = 0;
let cancelDelay = null;
const inspection = createInspectionGate();

function checkOnce() {
  return inspection.checkOnce(() => run());
}

function currentScheduleStatus() {
  return { enabled: scheduleEnabled, running: inspection.isChecking() };
}

function monitorSnapshot(serverId = '') {
  const key = serverId || '*';
  return inspection.monitorServer(key, async () => {
    config = await loadMonitorConfig();
    if (serverId) {
      const server = config.servers.find((item) => item.id === serverId);
      if (!server) throw new Error(`没有找到服务器“${serverId}”`);
      if (server.enabled === false) throw new Error(`【${server.name}】监控已关闭`);
      const missing = missingCredentials([server]);
      if (missing.length > 0) throw new Error(`请先在 .env 中填写：${missing.join('、')}`);
      const view = await inspectServerView(server);
      return { generatedAt: new Date().toISOString(), server: view };
    }
    const active = config.servers.filter((server) => server.enabled !== false);
    const missing = missingCredentials(active);
    if (missing.length > 0) throw new Error(`请先在 .env 中填写：${missing.join('、')}`);
    if (active.length === 0) {
      return { generatedAt: new Date().toISOString(), servers: [], message: '没有启用监控的服务器' };
    }
    const servers = await Promise.all(active.map((server) => inspectServerView(server)));
    return { generatedAt: new Date().toISOString(), servers };
  });
}

async function inspectServerView(server) {
  try {
    return buildMonitorView(server, await inspect(server));
  } catch (error) {
    return {
      id: server.id,
      name: server.name,
      threshold: server.estimatedCostThreshold,
      lowGroupCount: 0,
      urgentAccountCount: 0,
      all: null,
      groups: [],
      error: error.message
    };
  }
}

async function nextScheduledCheck() {
  for (;;) {
    const activeRun = inspection.currentRun();
    if (activeRun) return activeRun;
    const activeMonitor = inspection.currentMonitor();
    if (!activeMonitor) return checkOnce();
    try {
      await activeMonitor;
    } catch {
      // 监控读取失败不代替这一轮告警巡检。
    }
  }
}

function delayUntilStopped(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelDelay = null;
      resolve();
    }, ms);
    cancelDelay = () => {
      clearTimeout(timer);
      cancelDelay = null;
      resolve();
    };
  });
}

async function runScheduleLoop(token) {
  console.log('定时巡检已启动。无异常不发送告警。');
  let announcedInterval = null;
  while (scheduleEnabled && token === scheduleToken) {
    try {
      process.exitCode = 0;
      const result = await nextScheduledCheck();
      if (result.failures.length > 0) process.exitCode = 1;
      if (announcedInterval !== config?.checkIntervalMinutes) {
        announcedInterval = config?.checkIntervalMinutes;
        if (announcedInterval) console.log(`检查间隔：${announcedInterval} 分钟`);
      }
    } catch (error) {
      process.exitCode = 1;
      console.error(`❌ ${error.message}`);
    }
    if (!scheduleEnabled || token !== scheduleToken) break;
    const intervalMs = Math.max(config?.checkIntervalMinutes || 60, 1) * 60 * 1000;
    const nextAt = new Date(Date.now() + intervalMs);
    console.log(`下次检查：${nextAt.toLocaleString('zh-CN', { hour12: false })}`);
    await delayUntilStopped(intervalMs);
  }
}

function setSchedule(enabled) {
  const next = Boolean(enabled);
  if (next === scheduleEnabled) return currentScheduleStatus();
  scheduleEnabled = next;
  scheduleToken += 1;
  cancelDelay?.();
  if (next) runScheduleLoop(scheduleToken);
  else console.log('定时巡检已停止。');
  return currentScheduleStatus();
}

async function schedule() {
  setSchedule(true);
  await new Promise(() => {});
}

async function listGroups(input) {
  config = await loadMonitorConfig();
  const server = {
    name: '分组查询',
    baseUrl: String(input?.baseUrl || '').trim().replace(/\/+$/, ''),
    email: String(input?.email || '').trim(),
    password: input?.password == null ? '' : String(input.password)
  };
  if (!server.baseUrl || !server.email || !server.password) {
    throw new Error('请先填写服务器地址、邮箱和密码');
  }
  const token = await login(server);
  try {
    return readGroupCatalog(await request(server, '/admin/groups/all?include_inactive=true', {}, token));
  } catch {
    return readGroupCatalog(await request(server, '/admin/groups/all', {}, token));
  }
}

async function startUi() {
  const port = Number(process.env.UI_PORT || 8787);
  const host = process.env.UI_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port <= 0) throw new Error('UI_PORT 不是有效端口');
  const ui = await serveUi({
    host,
    port,
    basePath: process.env.UI_BASE_PATH || '',
    loadConfig: () => loadMonitorConfig(),
    saveConfig: (input) => saveMonitorConfig(input),
    listGroups,
    checkOnce,
    scheduleStatus: currentScheduleStatus,
    setSchedule,
    monitorSnapshot
  });
  console.log(`配置页面：${ui.address}`);
}

async function main() {
  const args = parseArgs();
  if (args.test) {
    console.log('配置测试模式：仅检查本地配置，不请求远程接口');
    config = await loadMonitorConfig();
    validateConfig();
    console.log('配置完整');
    return;
  }

  if (args.ui) {
    await startUi();
    return;
  }

  if (args.schedule) {
    await schedule();
    return;
  }

  const result = await run();
  if (result.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
});

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  formatNumber,
  getAccountName,
  getQuotaAlerts,
  getPaginationTotal,
  isMonitorableAccount,
  resolveAccountCost,
  shouldFetchUsage,
  unwrapList,
  usageQuery,
  parseMonitorConfig,
  buildServerAlerts,
  buildServerFailureAlert,
  formatAlertMessage,
  isOpenAIPlatform
} from './logic.js';

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

const config = {
  ...parseMonitorConfig(process.env)
};

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return { once: args.has('--once'), test: args.has('--test'), schedule: args.has('--schedule') };
}

function validateConfig() {
  const missing = [];
  if (!config.webhookUrl) missing.push('WECOM_WEBHOOK_URL');
  for (const server of config.servers) {
    if (!server.baseUrl) missing.push(server.settings.baseUrl);
    if (!server.email) missing.push(server.settings.email);
    if (!server.password) missing.push(server.settings.password);
  }
  if (missing.length > 0) {
    throw new Error(`请先在 .env 中填写：${missing.join('、')}`);
  }
  if (config.checkIntervalMinutes <= 0) {
    throw new Error('CHECK_INTERVAL_MINUTES 必须大于 0');
  }
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
  const accounts = [];
  for (let page = 1; page <= 1000; page += 1) {
    const payload = await request(server, `/admin/accounts?page=${page}&page_size=${config.pageSize}`, {}, token);
    const current = unwrapList(payload);
    accounts.push(...current);
    const total = getPaginationTotal(payload);
    if (current.length === 0 || (total !== null && accounts.length >= total) || current.length < config.pageSize) {
      break;
    }
  }
  return accounts;
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
  const allAccounts = (await getAllAccounts(server, token)).filter(isMonitorableAccount);
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
      estimatedCost: resolved.cost ?? 0,
      quotaAlerts: usageItem ? getQuotaAlerts(usageItem, account, config.quotaRemainPercent) : []
    });
  }

  if (missingCost.length > 0) {
    throw new Error(`以下账号用量获取失败，无法计算预计总费用：${missingCost.join('、')}`);
  }

  const allEstimatedCost = records.reduce((sum, record) => sum + record.estimatedCost, 0);
  const openaiEstimatedCost = records
    .filter(({ account }) => isOpenAIPlatform(account))
    .reduce((sum, record) => sum + record.estimatedCost, 0);
  const quotaAlerts = records.flatMap((record) => record.quotaAlerts);

  return { allEstimatedCost, openaiEstimatedCost, quotaAlerts, accountCount: records.length };
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
  validateConfig();
  const state = await readState();
  const now = Date.now();
  const pending = [];
  const failures = [];

  for (const server of config.servers) {
    try {
      const result = await inspect(server);
      console.log(`【${server.name}】检查完成：${result.accountCount} 个账号，所有账号预计总费用 ${formatNumber(result.allEstimatedCost)}，OpenAI 平台 ${formatNumber(result.openaiEstimatedCost)}`);
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

  if (failures.length > 0) process.exitCode = 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function schedule() {
  validateConfig();
  const intervalMs = config.checkIntervalMinutes * 60 * 1000;
  console.log(`定时巡检已启动，每 ${config.checkIntervalMinutes} 分钟检查一次。无异常不发送告警。`);
  for (;;) {
    try {
      process.exitCode = 0;
      await run();
    } catch (error) {
      process.exitCode = 1;
      console.error(`❌ ${error.message}`);
    }
    const nextAt = new Date(Date.now() + intervalMs);
    console.log(`下次检查：${nextAt.toLocaleString('zh-CN', { hour12: false })}`);
    await delay(intervalMs);
  }
}

async function main() {
  const args = parseArgs();
  if (args.test) {
    console.log('配置测试模式：仅检查 .env 配置，不请求远程接口');
    validateConfig();
    console.log('配置完整');
    return;
  }

  if (args.schedule) {
    await schedule();
    return;
  }

  await run();
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
});

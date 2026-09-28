import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  formatNumber,
  formatResetTime,
  getAccountName,
  getEstimatedTotalCost,
  getGroupName,
  getQuotaAlerts,
  getPaginationTotal,
  isMonitorableAccount,
  unwrapList
} from './logic.js';

const DEFAULT_BASE_URL = 'http://103.204.174.231:8080';
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
  baseUrl: (process.env.SUB2API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  email: process.env.SUB2API_EMAIL || '',
  password: process.env.SUB2API_PASSWORD || '',
  webhookUrl: process.env.WECOM_WEBHOOK_URL || '',
  estimatedCostThreshold: Number(process.env.ESTIMATED_COST_THRESHOLD || 500),
  quotaRemainPercent: Number(process.env.QUOTA_REMAIN_PERCENT || 20),
  openaiGroupName: process.env.OPENAI_GROUP_NAME || 'OpenAI',
  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 60),
  pageSize: Number(process.env.PAGE_SIZE || 100),
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000)
};

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return { once: args.has('--once'), test: args.has('--test') };
}

function validateConfig() {
  const missing = [];
  if (!config.email) missing.push('SUB2API_EMAIL');
  if (!config.password) missing.push('SUB2API_PASSWORD');
  if (!config.webhookUrl) missing.push('WECOM_WEBHOOK_URL');
  if (missing.length > 0) {
    throw new Error(`请先在 .env 中填写：${missing.join('、')}`);
  }
}

async function request(path, options = {}, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  try {
    const response = await fetch(`${config.baseUrl}/api/v1${path}`, {
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

async function login() {
  const body = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: config.email, password: config.password })
  });
  const token = body?.access_token ?? body?.data?.access_token;
  if (!token) throw new Error('登录成功响应中没有 access_token');
  return token;
}

async function getAllAccounts(token) {
  const accounts = [];
  for (let page = 1; page <= 1000; page += 1) {
    const payload = await request(`/admin/accounts?page=${page}&page_size=${config.pageSize}`, {}, token);
    const current = unwrapList(payload);
    accounts.push(...current);
    const total = getPaginationTotal(payload);
    if (current.length === 0 || (total !== null && accounts.length >= total) || current.length < config.pageSize) {
      break;
    }
  }
  return accounts;
}

async function getUsage(token, accountId) {
  return request(`/admin/accounts/${encodeURIComponent(accountId)}/usage?source=passive`, {}, token);
}

async function inspect(token) {
  const allAccounts = (await getAllAccounts(token)).filter(isMonitorableAccount);
  const records = [];
  const missingCost = [];

  for (const account of allAccounts) {
    let usage = null;
    try {
      usage = await getUsage(token, account.id);
    } catch (error) {
      console.warn(`获取账号“${getAccountName(account)}”用量失败：${error.message}`);
    }

    const estimatedCost = getEstimatedTotalCost(account) ?? getEstimatedTotalCost(usage);
    if (estimatedCost === null) {
      missingCost.push(getAccountName(account));
    }

    records.push({
      account,
      estimatedCost,
      quotaAlerts: usage ? getQuotaAlerts(usage, account, config.quotaRemainPercent) : []
    });
  }

  if (missingCost.length > 0) {
    throw new Error(`以下账号没有预计总费用字段：${missingCost.join('、')}`);
  }

  const allEstimatedCost = records.reduce((sum, record) => sum + record.estimatedCost, 0);
  const openaiEstimatedCost = records
    .filter(({ account }) => getGroupName(account) === config.openaiGroupName)
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

function buildAlerts(result) {
  const alerts = [];
  if (result.allEstimatedCost < config.estimatedCostThreshold) {
    alerts.push({
      key: 'all-estimated-cost',
      text: `⚠️ 所有账号预计总费用：${formatNumber(result.allEstimatedCost)}（阈值 ${formatNumber(config.estimatedCostThreshold)}）`
    });
  }
  if (result.openaiEstimatedCost < config.estimatedCostThreshold) {
    alerts.push({
      key: 'openai-estimated-cost',
      text: `⚠️ OpenAI 分组预计总费用：${formatNumber(result.openaiEstimatedCost)}（阈值 ${formatNumber(config.estimatedCostThreshold)}）`
    });
  }
  for (const alert of result.quotaAlerts) {
    const reset = formatResetTime(alert.resetsAt);
    alerts.push({
      key: `quota:${alert.accountId ?? alert.accountName}:${alert.windowName}`,
      text: `⚠️ 单账号额度不足：${alert.accountName}（${alert.groupName} / ${alert.platformName}）${alert.windowName} 剩余 ${formatNumber(alert.remainingPercent)}%${reset ? `，预计重置：${reset}` : ''}`
    });
  }
  return alerts;
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
  const token = await login();
  const result = await inspect(token);
  const alerts = buildAlerts(result);
  const state = await readState();
  const now = Date.now();
  const pending = alerts.filter((alert) => shouldSend(alert.key, state, now));

  console.log(`检查完成：${result.accountCount} 个账号，所有账号预计总费用 ${formatNumber(result.allEstimatedCost)}，OpenAI 分组 ${formatNumber(result.openaiEstimatedCost)}`);
  if (pending.length === 0) {
    console.log('无新告警');
    return;
  }

  const message = `🚨 账号额度警报\n\n${pending.map((alert) => alert.text).join('\n')}`;
  await sendWebhook(message);
  for (const alert of pending) state[alert.key] = now;
  await writeState(state);
  console.log(`已推送 ${pending.length} 条告警`);
}

async function main() {
  const args = parseArgs();
  if (args.test) {
    console.log('配置测试模式：仅检查 .env 配置，不请求远程接口');
    validateConfig();
    console.log('配置完整');
    return;
  }

  await run();
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
});

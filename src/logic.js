const ESTIMATED_COST_KEYS = [
  'estimated_total_cost',
  'estimatedTotalCost',
  'total_estimated_cost',
  'totalEstimatedCost',
  'estimated_cost',
  'estimatedCost'
];

const ACCOUNT_NAME_KEYS = ['name', 'account_name', 'accountName', 'email', 'username'];
const GROUP_KEYS = ['group_name', 'groupName', 'group'];
const PLATFORM_KEYS = ['platform', 'platform_name', 'platformName', 'provider'];

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }
  return undefined;
}

function firstDefinedDeep(object, keys) {
  const direct = firstDefined(object, keys);
  if (direct !== undefined) return direct;

  for (const nestedKey of ['data', 'usage', 'billing', 'details']) {
    const nested = object?.[nestedKey];
    if (nested && typeof nested === 'object') {
      const value = firstDefined(nested, keys);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;

  const normalized = value.replace(/[$,\s]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function usageRoot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.seven_day || payload.five_hour) return payload;
  for (const key of ['data', 'usage']) {
    const nested = payload[key];
    if (nested && typeof nested === 'object' && (nested.seven_day || nested.five_hour)) return nested;
  }
  return payload;
}

function estimatedCostFromWindow(payload) {
  const sevenDay = usageRoot(payload)?.seven_day;
  const utilization = sevenDay?.utilization;
  const currentCost = sevenDay?.window_stats?.cost;
  if (
    typeof utilization !== 'number' ||
    typeof currentCost !== 'number' ||
    !Number.isFinite(utilization) ||
    !Number.isFinite(currentCost) ||
    utilization <= 0 ||
    currentCost <= 0
  ) {
    return null;
  }

  const estimate = (currentCost * 100) / utilization;
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

export function getEstimatedTotalCost(account) {
  const explicit = toFiniteNumber(firstDefinedDeep(account, ESTIMATED_COST_KEYS));
  if (explicit !== null) return explicit;
  return estimatedCostFromWindow(account);
}

export function getAccountName(account) {
  return String(firstDefined(account, ACCOUNT_NAME_KEYS) ?? account?.id ?? '未知账号');
}

function groupNameFromItem(group) {
  if (typeof group === 'string' && group.trim() !== '') return group.trim();
  if (!group || typeof group !== 'object') return '';
  const name = group.name ?? group.group_name ?? group.groupName;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : '';
}

export function getGroupNames(account) {
  const names = [];
  if (Array.isArray(account?.groups)) {
    for (const group of account.groups) {
      const name = groupNameFromItem(group);
      if (name) names.push(name);
    }
  }
  const legacyName = groupNameFromItem(firstDefined(account, GROUP_KEYS));
  if (legacyName) names.push(legacyName);
  return [...new Set(names)];
}

export function getGroupName(account) {
  return getGroupNames(account)[0] ?? '未分组';
}

export function accountInGroup(account, groupName) {
  if (!groupName) return false;
  return getGroupNames(account).includes(groupName);
}

function accountType(account) {
  return String(account?.type ?? account?.account_type ?? '').toLowerCase();
}

function accountPlatform(account) {
  return String(account?.platform ?? '').toLowerCase();
}

export function shouldFetchUsage(account) {
  const platform = accountPlatform(account);
  const type = accountType(account);
  if (platform === 'anthropic') return type === 'oauth' || type === 'setup-token';
  if (platform === 'gemini') return true;
  if (platform === 'antigravity' || platform === 'grok' || platform === 'openai') return type === 'oauth';
  return false;
}

export function usageQuery(account) {
  const platform = accountPlatform(account);
  const type = accountType(account);
  if (platform === 'anthropic' && (type === 'oauth' || type === 'setup-token')) return '?source=passive';
  return '';
}

export function resolveAccountCost(account, usage, { fetchFailed = false } = {}) {
  const fromAccount = toFiniteNumber(firstDefinedDeep(account, ESTIMATED_COST_KEYS));
  const fromUsage = usage ? getEstimatedTotalCost(usage) : null;
  const cost = fromAccount ?? fromUsage;

  if (!shouldFetchUsage(account)) {
    return { include: cost !== null, cost: cost ?? 0, missing: false };
  }
  if (fetchFailed && fromAccount === null) {
    return { include: false, cost: null, missing: true };
  }
  return { include: true, cost: cost ?? 0, missing: false };
}

export function getPlatformName(account) {
  return String(firstDefined(account, PLATFORM_KEYS) ?? '未知平台');
}

export function isOpenAIPlatform(account) {
  return getPlatformName(account).trim().toLowerCase() === 'openai';
}

export function isMonitorableAccount(account) {
  const status = String(account?.status ?? '').toLowerCase();
  if (['disabled', 'inactive', 'deleted', 'error'].includes(status)) return false;
  if (account?.schedulable === false || account?.is_schedulable === false) return false;
  return true;
}

function normalizePercent(value) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  return number <= 1 ? number * 100 : number;
}

function readWindow(usage, keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (value && typeof value === 'object') return value;
    const nestedValue = usage?.windows?.[key];
    if (nestedValue && typeof nestedValue === 'object') return nestedValue;
  }
  return undefined;
}

function getWindowRemaining(usage, windowName) {
  const aliases = windowName === '5h'
    ? ['5h', 'five_hour', 'fiveHour', 'five_hours', 'fiveHours', 'usage_5h', 'usage5h', 'five_hour_usage']
    : ['7d', 'seven_day', 'sevenDay', 'seven_days', 'sevenDays', 'weekly', 'usage_7d', 'usage7d', 'seven_day_usage'];
  const window = readWindow(usage, aliases);

  const directUtilization = window?.utilization ?? window?.used_percent ?? window?.usedPercent;
  const directRemaining = window?.remaining_percent ?? window?.remainingPercent;
  const utilization = normalizePercent(directUtilization);
  const remaining = normalizePercent(directRemaining);

  if (remaining !== null) {
    return { exists: true, remainingPercent: Math.max(0, Math.min(100, remaining)), resetsAt: window?.resets_at ?? window?.resetsAt };
  }
  if (utilization !== null) {
    return { exists: true, remainingPercent: Math.max(0, Math.min(100, 100 - utilization)), resetsAt: window?.resets_at ?? window?.resetsAt };
  }

  const flatUtilizationKeys = windowName === '5h'
    ? ['five_hour_utilization', 'fiveHourUtilization', 'five_h_utilization', 'five_h_used_percent', 'quota_5h_utilization']
    : ['seven_day_utilization', 'sevenDayUtilization', 'seven_d_utilization', 'seven_d_used_percent', 'quota_7d_utilization'];
  const flatRemainingKeys = windowName === '5h'
    ? ['five_hour_remaining_percent', 'fiveHourRemainingPercent', 'five_h_remaining_percent', 'quota_5h_remaining_percent']
    : ['seven_day_remaining_percent', 'sevenDayRemainingPercent', 'seven_d_remaining_percent', 'quota_7d_remaining_percent'];

  const flatRemaining = normalizePercent(firstDefined(usage, flatRemainingKeys));
  const flatUtilization = normalizePercent(firstDefined(usage, flatUtilizationKeys));
  const resetsAt = firstDefined(usage, windowName === '5h'
    ? ['five_hour_resets_at', 'fiveHourResetsAt', 'five_h_resets_at']
    : ['seven_day_resets_at', 'sevenDayResetsAt', 'seven_d_resets_at']);

  if (flatRemaining !== null) {
    return { exists: true, remainingPercent: Math.max(0, Math.min(100, flatRemaining)), resetsAt };
  }
  if (flatUtilization !== null) {
    return { exists: true, remainingPercent: Math.max(0, Math.min(100, 100 - flatUtilization)), resetsAt };
  }

  // Some deployments return one 5h UsageProgress object directly.
  if (windowName === '5h') {
    const directUtilization = normalizePercent(firstDefined(usage, ['utilization', 'used_percent', 'usedPercent']));
    if (directUtilization !== null) {
      return {
        exists: true,
        remainingPercent: Math.max(0, Math.min(100, 100 - directUtilization)),
        resetsAt: usage?.resets_at ?? usage?.resetsAt
      };
    }

    const seconds = toFiniteNumber(usage.remaining_seconds);
    const duration = toFiniteNumber(usage.window_seconds ?? usage.limit_seconds) ?? 5 * 60 * 60;
    if (seconds !== null && duration !== null && duration > 0) {
      return {
        exists: true,
        remainingPercent: Math.max(0, Math.min(100, (seconds / duration) * 100)),
        resetsAt: usage.resets_at
      };
    }
  }

  return { exists: false, remainingPercent: 100, resetsAt: undefined };
}

export function getQuotaAlerts(usage, account, thresholdPercent) {
  const source = usage?.data && typeof usage.data === 'object' ? usage.data : usage;
  const alerts = [];
  for (const windowName of ['5h', '7d']) {
    const result = getWindowRemaining(source, windowName);
    if (result.exists && result.remainingPercent < thresholdPercent) {
      alerts.push({
        accountId: account?.id,
        accountName: getAccountName(account),
        groupName: getGroupName(account),
        platformName: getPlatformName(account),
        windowName,
        remainingPercent: result.remainingPercent,
        resetsAt: result.resetsAt
      });
    }
  }
  return alerts;
}

export function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'data', 'accounts', 'results']) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (payload?.[key] && typeof payload[key] === 'object') {
      const nested = unwrapList(payload[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

export function getPaginationTotal(payload) {
  return toFiniteNumber(payload?.total ?? payload?.count ?? payload?.data?.total);
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return '未知';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function formatResetTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

const SERVER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function readNumber(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`${key} 不是有效数字`);
  return number;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function serverNameFromUrl(baseUrl, fallback) {
  try {
    return new URL(baseUrl).host || fallback;
  } catch {
    return fallback;
  }
}

function parseLegacyServer(env) {
  const baseUrl = normalizeBaseUrl(env.SUB2API_BASE_URL);
  const name = String(env.SUB2API_NAME || '').trim() || serverNameFromUrl(baseUrl, '默认服务器');
  return {
    id: 'default',
    name,
    baseUrl,
    email: String(env.SUB2API_EMAIL || '').trim(),
    password: String(env.SUB2API_PASSWORD || ''),
    settings: {
      baseUrl: 'SUB2API_BASE_URL',
      email: 'SUB2API_EMAIL',
      password: 'SUB2API_PASSWORD'
    }
  };
}

function parseNamedServer(env, id) {
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new Error(`SUB2API_SERVERS 包含无效标识“${id}”，只允许字母、数字和下划线，且必须以字母开头`);
  }
  const prefix = `SUB2API_SERVER_${id.toUpperCase()}_`;
  const baseUrl = normalizeBaseUrl(env[`${prefix}BASE_URL`]);
  const name = String(env[`${prefix}NAME`] || '').trim() || serverNameFromUrl(baseUrl, id);
  return {
    id,
    name,
    baseUrl,
    email: String(env[`${prefix}EMAIL`] || '').trim(),
    password: String(env[`${prefix}PASSWORD`] || ''),
    settings: {
      baseUrl: `${prefix}BASE_URL`,
      email: `${prefix}EMAIL`,
      password: `${prefix}PASSWORD`
    }
  };
}

export function parseMonitorConfig(env = {}) {
  const ids = String(env.SUB2API_SERVERS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw new Error('SUB2API_SERVERS 包含重复的服务器标识');
  }

  return {
    webhookUrl: String(env.WECOM_WEBHOOK_URL || '').trim(),
    estimatedCostThreshold: readNumber(env, 'ESTIMATED_COST_THRESHOLD', 500),
    quotaRemainPercent: readNumber(env, 'QUOTA_REMAIN_PERCENT', 20),
    cooldownMinutes: readNumber(env, 'ALERT_COOLDOWN_MINUTES', 60),
    pageSize: readNumber(env, 'PAGE_SIZE', 100),
    timeoutMs: readNumber(env, 'REQUEST_TIMEOUT_MS', 30000),
    checkIntervalMinutes: readNumber(env, 'CHECK_INTERVAL_MINUTES', 60),
    servers: ids.length > 0
      ? ids.map((id) => parseNamedServer(env, id))
      : [parseLegacyServer(env)]
  };
}

export function buildServerAlerts(server, result, config) {
  const label = `【${server.name}】`;
  const alerts = [];
  if (result.allEstimatedCost < config.estimatedCostThreshold) {
    alerts.push({
      key: `${server.id}:all-estimated-cost`,
      text: `⚠️ ${label}所有账号预计总费用：${formatNumber(result.allEstimatedCost)}（阈值 ${formatNumber(config.estimatedCostThreshold)}）`
    });
  }
  if (result.openaiEstimatedCost < config.estimatedCostThreshold) {
    alerts.push({
      key: `${server.id}:openai-estimated-cost`,
      text: `⚠️ ${label}OpenAI 平台预计总费用：${formatNumber(result.openaiEstimatedCost)}（阈值 ${formatNumber(config.estimatedCostThreshold)}）`
    });
  }
  for (const alert of result.quotaAlerts) {
    const reset = formatResetTime(alert.resetsAt);
    alerts.push({
      key: `${server.id}:quota:${alert.accountId ?? alert.accountName}:${alert.windowName}`,
      text: `⚠️ ${label}单账号额度不足：${alert.accountName}（${alert.groupName} / ${alert.platformName}）${alert.windowName} 剩余 ${formatNumber(alert.remainingPercent)}%${reset ? `，预计重置：${reset}` : ''}`
    });
  }
  return alerts;
}

export function buildServerFailureAlert(server, message) {
  return {
    key: `${server.id}:inspect-failed`,
    text: `⚠️ 【${server.name}】巡检失败：${message}`
  };
}

export function formatAlertMessage(alerts) {
  return `🚨 账号额度警报\n\n${alerts.map((alert) => alert.text).join('\n')}`;
}

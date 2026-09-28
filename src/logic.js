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

export function getEstimatedTotalCost(account) {
  const value = firstDefinedDeep(account, ESTIMATED_COST_KEYS);
  return toFiniteNumber(value);
}

export function getAccountName(account) {
  return String(firstDefined(account, ACCOUNT_NAME_KEYS) ?? account?.id ?? '未知账号');
}

export function getGroupName(account) {
  return String(firstDefined(account, GROUP_KEYS) ?? '未分组');
}

export function getPlatformName(account) {
  return String(firstDefined(account, PLATFORM_KEYS) ?? '未知平台');
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

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
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return usageRoot(nested);
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

export function getUsedCost(payload) {
  const cost = usageRoot(payload)?.seven_day?.window_stats?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export function getUsageUpdatedAt(payload) {
  const value = firstDefined(usageRoot(payload), ['updated_at', 'updatedAt']);
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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

export function normalizeGroupRef(value) {
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { id: null, name } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name ?? value.group_name ?? value.groupName ?? '').trim();
  const rawId = value.id;
  const id = rawId === undefined || rawId === null || rawId === '' ? null : rawId;
  if (!name && id == null) return null;
  return { id, name: name || `分组#${id}` };
}

function parseGroupList(value) {
  if (Array.isArray(value)) return value.map(normalizeGroupRef).filter(Boolean);
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    return value.split(/[,，]/).map((item) => normalizeGroupRef(item)).filter(Boolean);
  }
  throw new Error('分组配置必须是列表或逗号分隔的名称');
}

function dedupeGroups(groups) {
  const result = [];
  for (const group of groups) {
    const existing = result.find((item) => (
      (group.id != null && item.id != null && String(group.id) === String(item.id))
      || (group.name && item.name === group.name)
    ));
    if (!existing) {
      result.push({ ...group });
      continue;
    }
    if (existing.id == null && group.id != null) existing.id = group.id;
  }
  return result;
}

export function accountMatchesGroup(account, group) {
  const target = normalizeGroupRef(group);
  if (!target) return false;
  if (
    target.id != null
    && Array.isArray(account?.group_ids)
    && account.group_ids.some((id) => String(id) === String(target.id))
  ) {
    return true;
  }
  if (Array.isArray(account?.groups)) {
    for (const item of account.groups) {
      if (!item || typeof item !== 'object') continue;
      if (target.id != null && item.id != null && String(item.id) === String(target.id)) return true;
    }
  }
  return target.name ? getGroupNames(account).includes(target.name) : false;
}

export function resolveMonitoredGroups(server, accounts) {
  if (server?.groupScope === 'selected') return dedupeGroups(parseGroupList(server.groups));
  const found = [];
  for (const account of accounts || []) {
    const items = Array.isArray(account?.groups) ? account.groups : [];
    if (items.length > 0) {
      found.push(...items.map(normalizeGroupRef).filter(Boolean));
      continue;
    }
    found.push(...getGroupNames(account).map((name) => ({ id: null, name })));
  }
  return dedupeGroups(found).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

export function summarizeGroupCosts(records, groups) {
  return (groups || []).map((group) => ({
    id: group.id ?? null,
    name: group.name,
    estimatedCost: (() => {
      const members = (records || []).filter((record) => accountMatchesGroup(record.account, group));
      if (members.length === 0 || members.some((record) => !Number.isFinite(record.estimatedCost))) return null;
      return members.reduce((sum, record) => sum + record.estimatedCost, 0);
    })()
  }));
}

export function readGroupCatalog(payload) {
  const source = collectGroupItems(payload);
  return dedupeGroups(source.map((item) => {
    const group = normalizeGroupRef(item);
    if (!group || !item || typeof item !== 'object') return group;
    const platform = item.platform ?? item.platform_name ?? item.platformName;
    return platform ? { ...group, platform: String(platform) } : group;
  }).filter(Boolean));
}

export function accountListQuery(page, pageSize, { status = 'active', lite = false } = {}) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('page_size', String(pageSize));
  if (status) params.set('status', status);
  if (lite) params.set('lite', '1');
  return `/admin/accounts?${params.toString()}`;
}

export function accountListKeepsMembership(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return true;
  return accounts.some((account) => (
    Array.isArray(account?.group_ids)
    || Array.isArray(account?.groups)
    || Array.isArray(account?.account_groups)
  ));
}

export function attachGroupCatalog(accounts, catalog) {
  const byId = new Map();
  for (const group of catalog || []) {
    if (!group || group.id == null || group.id === '') continue;
    byId.set(String(group.id), group);
  }
  return (accounts || []).map((account) => {
    if (!account || typeof account !== 'object') return account;
    if (getGroupNames(account).length > 0) return account;
    const ids = Array.isArray(account.group_ids) ? account.group_ids : [];
    if (ids.length === 0) return account;
    const groups = ids.map((id) => {
      const known = byId.get(String(id));
      return { id: known?.id ?? id, name: known?.name ? String(known.name) : `分组#${id}` };
    });
    return { ...account, groups };
  });
}

function collectGroupItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['groups', 'items', 'data', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') return collectGroupItems(payload.data);
  return [];
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
  // A successful usage response can legitimately omit billing/estimate data.
  // Keep it unknown so monetary alerts do not turn missing data into a false zero.
  return { include: true, cost, missing: false };
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
  // Sub2API utilization and *_percent fields use percentage points: 1 means 1%.
  return toFiniteNumber(value);
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
  }

  // remaining_seconds is a reset countdown, not an amount of available quota.
  return { exists: false, remainingPercent: 100, resetsAt: undefined };
}

export function getQuotaAlerts(usage, account, thresholdPercent) {
  const source = usageRoot(usage) ?? {};
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

function sumUsedCost(records) {
  if ((records || []).some((record) => !Number.isFinite(record.estimatedCost))) return null;
  const values = (records || []).map((record) => record.usedCost).filter((value) => Number.isFinite(value));
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function presentUrgentAccount(record) {
  return {
    id: record.account?.id ?? null,
    name: getAccountName(record.account),
    groupName: getGroupName(record.account),
    platform: getPlatformName(record.account),
    estimatedCost: record.estimatedCost,
    usedCost: Number.isFinite(record.estimatedCost) && Number.isFinite(record.usedCost) ? record.usedCost : null,
    usageUpdatedAt: getUsageUpdatedAt({ updated_at: record.usageUpdatedAt }),
    windows: (record.quotaAlerts || []).map((alert) => ({
      windowName: alert.windowName,
      remainingPercent: alert.remainingPercent
    }))
  };
}

export function buildMonitorView(server, result) {
  const threshold = server.estimatedCostThreshold;
  const records = result.records || [];
  const usageTimestamps = records.map((record) => getUsageUpdatedAt({ updated_at: record.usageUpdatedAt })).filter(Boolean);
  const usageUpdatedAt = usageTimestamps.reduce((oldest, timestamp) =>
    oldest === null || Date.parse(timestamp) < Date.parse(oldest) ? timestamp : oldest, null);
  const monitored = resolveMonitoredGroups(server, records.map((record) => record.account));
  const inScope = records.filter((record) => monitored.some((group) => accountMatchesGroup(record.account, group)));
  const groups = (result.groupCosts || []).map((group) => {
    const members = inScope.filter((record) => accountMatchesGroup(record.account, group));
    const urgent = members.filter((record) => (record.quotaAlerts || []).length > 0);
    return {
      id: group.id ?? null,
      name: group.name,
      estimatedCost: group.estimatedCost,
      usedCost: sumUsedCost(members),
      low: Number.isFinite(group.estimatedCost) && group.estimatedCost < threshold,
      urgentCount: urgent.length,
      accounts: urgent.map(presentUrgentAccount)
    };
  }).filter((group) => group.low || group.urgentCount > 0);

  const urgentIds = new Set();
  for (const record of inScope) {
    if ((record.quotaAlerts || []).length === 0) continue;
    urgentIds.add(record.account?.id ?? getAccountName(record.account));
  }

  const allLow = server.monitorAllAccounts !== false
    && Number.isFinite(result.allEstimatedCost)
    && result.allEstimatedCost < threshold;
  return {
    id: server.id,
    name: server.name,
    threshold,
    usageUpdatedAt,
    usageTimestampMissingCount: records.length - usageTimestamps.length,
    unknownCostGroupCount: (result.groupCosts || []).filter((group) => !Number.isFinite(group.estimatedCost)).length,
    lowGroupCount: groups.filter((group) => group.low).length,
    urgentAccountCount: urgentIds.size,
    all: allLow ? {
      estimatedCost: result.allEstimatedCost,
      usedCost: sumUsedCost(records),
      accountCount: result.accountCount
    } : null,
    groups,
    error: null
  };
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

function readConfigNumber(value, key, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) throw new Error(`${key} 不是有效数字`);
  return number;
}

function readBool(value, key, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`${key} 不是有效布尔值`);
}

function normalizeGroupScope(value, label) {
  const scope = String(value || 'all').trim().toLowerCase();
  if (scope === 'all' || scope === 'selected') return scope;
  throw new Error(`${label} 的分组范围只能是 all 或 selected`);
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
    groupScope: env.SUB2API_GROUP_SCOPE,
    groups: env.SUB2API_GROUPS,
    enabled: env.SUB2API_ENABLED,
    monitorAllAccounts: env.SUB2API_MONITOR_ALL_ACCOUNTS ?? env.MONITOR_ALL_ACCOUNTS,
    estimatedCostThreshold: env.SUB2API_ESTIMATED_COST_THRESHOLD ?? env.ESTIMATED_COST_THRESHOLD,
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
    groupScope: env[`${prefix}GROUP_SCOPE`],
    groups: env[`${prefix}GROUPS`],
    enabled: env[`${prefix}ENABLED`],
    monitorAllAccounts: env[`${prefix}MONITOR_ALL_ACCOUNTS`] ?? env.MONITOR_ALL_ACCOUNTS,
    estimatedCostThreshold: env[`${prefix}ESTIMATED_COST_THRESHOLD`] ?? env.ESTIMATED_COST_THRESHOLD,
    settings: {
      baseUrl: `${prefix}BASE_URL`,
      email: `${prefix}EMAIL`,
      password: `${prefix}PASSWORD`
    }
  };
}

function firstPresent(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function normalizeServer(server, index, fallback = {}) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new Error(`第 ${index + 1} 台服务器配置无效`);
  }
  const id = String(server.id || '').trim();
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new Error(`服务器标识“${id || index + 1}”无效，只允许字母、数字和下划线，且必须以字母开头`);
  }
  const baseUrl = normalizeBaseUrl(server.baseUrl);
  const name = String(server.name || '').trim() || serverNameFromUrl(baseUrl, id);
  return {
    id,
    name,
    baseUrl,
    email: String(server.email || '').trim(),
    password: server.password == null ? '' : String(server.password),
    groupScope: normalizeGroupScope(server.groupScope, name),
    groups: dedupeGroups(parseGroupList(server.groups)),
    enabled: readBool(server.enabled, `${name} 的监控开关`, true),
    monitorAllAccounts: readBool(firstPresent(server.monitorAllAccounts, fallback.monitorAllAccounts), `${name} 的全账号预计总费用告警`, true),
    estimatedCostThreshold: readConfigNumber(firstPresent(server.estimatedCostThreshold, fallback.estimatedCostThreshold), `${name} 的预计总费用阈值`, 500),
    settings: server.settings || {
      baseUrl: `${name} 的地址`,
      email: `${name} 的邮箱`,
      password: `${name} 的密码`
    }
  };
}

export function normalizeMonitorConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象');
  const servers = Array.isArray(input.servers)
    ? input.servers.map((server, index) => normalizeServer(server, index, {
      monitorAllAccounts: input.monitorAllAccounts,
      estimatedCostThreshold: input.estimatedCostThreshold
    }))
    : [];
  if (servers.length === 0) throw new Error('至少需要一台服务器');
  if (new Set(servers.map((server) => server.id)).size !== servers.length) {
    throw new Error('服务器标识不能重复');
  }

  const checkIntervalMinutes = readConfigNumber(input.checkIntervalMinutes, 'CHECK_INTERVAL_MINUTES', 60);
  const pageSize = readConfigNumber(input.pageSize, 'PAGE_SIZE', 100);
  const timeoutMs = readConfigNumber(input.timeoutMs, 'REQUEST_TIMEOUT_MS', 30000);
  if (checkIntervalMinutes <= 0) throw new Error('CHECK_INTERVAL_MINUTES 必须大于 0');
  if (pageSize <= 0) throw new Error('PAGE_SIZE 必须大于 0');
  if (timeoutMs <= 0) throw new Error('REQUEST_TIMEOUT_MS 必须大于 0');

  return {
    webhookUrl: String(input.webhookUrl || '').trim(),
    quotaRemainPercent: readConfigNumber(input.quotaRemainPercent, 'QUOTA_REMAIN_PERCENT', 20),
    cooldownMinutes: readConfigNumber(input.cooldownMinutes, 'ALERT_COOLDOWN_MINUTES', 60),
    pageSize,
    timeoutMs,
    checkIntervalMinutes,
    servers
  };
}

export function parseMonitorConfig(env = {}) {
  const ids = String(env.SUB2API_SERVERS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw new Error('SUB2API_SERVERS 包含重复的服务器标识');
  }

  return normalizeMonitorConfig({
    webhookUrl: env.WECOM_WEBHOOK_URL,
    estimatedCostThreshold: readNumber(env, 'ESTIMATED_COST_THRESHOLD', 500),
    quotaRemainPercent: readNumber(env, 'QUOTA_REMAIN_PERCENT', 20),
    cooldownMinutes: readNumber(env, 'ALERT_COOLDOWN_MINUTES', 60),
    pageSize: readNumber(env, 'PAGE_SIZE', 100),
    timeoutMs: readNumber(env, 'REQUEST_TIMEOUT_MS', 30000),
    checkIntervalMinutes: readNumber(env, 'CHECK_INTERVAL_MINUTES', 60),
    servers: ids.length > 0
      ? ids.map((id) => parseNamedServer(env, id))
      : [parseLegacyServer(env)]
  });
}

export function buildServerAlerts(server, result, config) {
  const label = `【${server.name}】`;
  const threshold = firstPresent(server.estimatedCostThreshold, config?.estimatedCostThreshold);
  const alerts = [];
  if (
    server.monitorAllAccounts !== false
    && Number.isFinite(result.allEstimatedCost)
    && result.allEstimatedCost < threshold
  ) {
    alerts.push({
      key: `${server.id}:all-estimated-cost`,
      text: `⚠️ ${label}所有账号预计总费用：${formatNumber(result.allEstimatedCost)}（阈值 ${formatNumber(threshold)}）`
    });
  }
  for (const group of result.groupCosts || []) {
    if (!Number.isFinite(group.estimatedCost) || group.estimatedCost >= threshold) continue;
    const identity = group.id == null || group.id === '' ? group.name : group.id;
    alerts.push({
      key: `${server.id}:group:${identity}`,
      text: `⚠️ ${label}分组「${group.name}」预计总费用：${formatNumber(group.estimatedCost)}（阈值 ${formatNumber(threshold)}）`
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

export function createInspectionGate() {
  let runPromise = null;
  const monitorReads = new Map();

  function busy() {
    const error = new Error('巡检进行中');
    error.statusCode = 409;
    throw error;
  }

  function checkOnce(run) {
    if (runPromise || monitorReads.size > 0) busy();
    runPromise = Promise.resolve()
      .then(run)
      .finally(() => {
        runPromise = null;
      });
    return runPromise;
  }

  function monitorServer(key, read) {
    const existing = monitorReads.get(key);
    if (existing) return existing;
    const currentRun = runPromise;
    const promise = (async () => {
      if (currentRun) {
        try {
          await currentRun;
        } catch {
          // 告警巡检自己报告失败，监控仍继续读取当前用量。
        }
      }
      return read();
    })().finally(() => {
      if (monitorReads.get(key) === promise) monitorReads.delete(key);
    });
    monitorReads.set(key, promise);
    return promise;
  }

  function monitorSnapshot(read) {
    return monitorServer('*', read);
  }

  function currentMonitor() {
    const pending = [...monitorReads.values()];
    return pending.length > 0 ? Promise.all(pending) : null;
  }

  return {
    checkOnce,
    monitorServer,
    monitorSnapshot,
    currentRun: () => runPromise,
    currentMonitor,
    isChecking: () => Boolean(runPromise)
  };
}

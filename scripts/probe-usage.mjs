import { readFileSync } from 'node:fs';

function loadDotEnv() {
  const text = readFileSync('.env', 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadDotEnv();

const baseUrl = (process.env.SUB2API_BASE_URL || 'http://103.204.174.231:8080').replace(/\/+$/, '');

async function request(path, options = {}, token) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { nonJson: true, length: text.length };
  }
  return { status: response.status, body };
}

function unwrap(body) {
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object') return body.data;
  return body;
}

function listAccounts(body) {
  const root = unwrap(body);
  if (Array.isArray(root)) return root;
  for (const key of ['items', 'accounts', 'results', 'list']) {
    if (Array.isArray(root?.[key])) return root[key];
  }
  return [];
}

function keyNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !['credentials', 'extra', 'proxy', 'notes'].includes(key)).sort();
}

function groupShape(account) {
  const groups = account.groups;
  const summary = {
    keys: ['group_id', 'group_ids', 'group_name', 'groupName', 'group', 'groups'].filter((key) => account[key] !== undefined),
    groupsType: Array.isArray(groups) ? 'array' : groups == null ? 'none' : typeof groups
  };
  if (Array.isArray(groups) && groups.length > 0) {
    const first = groups[0];
    summary.groupItemKeys = first && typeof first === 'object' ? Object.keys(first).sort() : [typeof first];
    summary.groupNames = groups
      .map((item) => (item && typeof item === 'object' ? item.name || item.group_name || item.platform : item))
      .filter((item) => typeof item === 'string')
      .slice(0, 4);
  } else if (typeof account.group === 'object' && account.group) {
    summary.groupItemKeys = Object.keys(account.group).sort();
    summary.groupNames = [account.group.name || account.group.group_name].filter(Boolean);
  } else if (typeof account.group_name === 'string' || typeof account.groupName === 'string' || typeof account.group === 'string') {
    summary.groupNames = [account.group_name || account.groupName || account.group];
  }
  return summary;
}

function usageShape(body) {
  const root = unwrap(body);
  const usage = root?.usage && typeof root.usage === 'object' ? root.usage : root;
  const seven = usage?.seven_day;
  const five = usage?.five_hour;
  const cost = seven?.window_stats?.cost;
  const utilization = seven?.utilization;
  return {
    topKeys: keyNames(body).slice(0, 20),
    dataKeys: keyNames(usage).slice(0, 30),
    hasFive: Boolean(five),
    hasSeven: Boolean(seven),
    sevenKeys: keyNames(seven),
    utilizationPositive: typeof utilization === 'number' && Number.isFinite(utilization) && utilization > 0,
    costPositive: typeof cost === 'number' && Number.isFinite(cost) && cost > 0,
    utilizationType: utilization == null ? 'missing' : typeof utilization,
    costType: cost == null ? 'missing' : typeof cost,
    windowStatsKeys: keyNames(seven?.window_stats)
  };
}

const login = await request('/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.SUB2API_EMAIL || '',
    password: process.env.SUB2API_PASSWORD || ''
  })
});
const token = login.body?.access_token || login.body?.data?.access_token;
if (!token) {
  console.log(JSON.stringify({ loginStatus: login.status, loginKeys: keyNames(login.body) }));
  process.exit(1);
}

const accounts = [];
for (let page = 1; page <= 20; page += 1) {
  const payload = await request(`/admin/accounts?page=${page}&page_size=100`, {}, token);
  const current = listAccounts(payload.body);
  accounts.push(...current);
  if (current.length < 100) break;
}

const counts = {};
const samples = new Map();
for (const account of accounts) {
  const platform = String(account.platform || account.platform_name || 'unknown');
  const type = String(account.type || account.account_type || 'unknown');
  const status = String(account.status || 'unknown');
  const key = `${platform}|${type}|${status}`;
  counts[key] = (counts[key] || 0) + 1;
  const sampleKey = `${platform}|${type}`;
  if (!samples.has(sampleKey)) samples.set(sampleKey, account);
}

const groupSamples = [...samples.values()].slice(0, 8).map((account) => ({
  id: account.id,
  platform: account.platform || null,
  type: account.type || null,
  status: account.status || null,
  schedulable: account.schedulable ?? account.is_schedulable ?? null,
  accountKeys: keyNames(account),
  group: groupShape(account)
}));

const usageSamples = [];
for (const account of [...samples.values()].slice(0, 6)) {
  const active = await request(`/admin/accounts/${account.id}/usage?source=active`, {}, token);
  const passive = await request(`/admin/accounts/${account.id}/usage?source=passive`, {}, token);
  usageSamples.push({
    id: account.id,
    platform: account.platform || null,
    type: account.type || null,
    activeStatus: active.status,
    passiveStatus: passive.status,
    active: active.status < 300 ? usageShape(active.body) : { errorKeys: keyNames(active.body), messageType: typeof (active.body?.message || active.body?.data?.message) },
    passive: passive.status < 300 ? usageShape(passive.body) : { errorKeys: keyNames(passive.body) }
  });
}

const batchIds = [...samples.values()].slice(0, 4).map((account) => account.id);
const batch = await request('/admin/accounts/usage/batch', {
  method: 'POST',
  body: JSON.stringify({ account_ids: batchIds, force: false })
}, token);
const batchData = unwrap(batch.body);
const batchUsage = batchData?.usage && typeof batchData.usage === 'object' ? batchData.usage : null;
const firstBatchUsage = batchUsage ? Object.values(batchUsage)[0] : null;

console.log(JSON.stringify({
  accountCount: accounts.length,
  counts,
  groupSamples,
  usageSamples,
  batch: {
    status: batch.status,
    topKeys: keyNames(batch.body),
    dataKeys: keyNames(batchData),
    usageCount: batchUsage ? Object.keys(batchUsage).length : 0,
    errorCount: batchData?.errors && typeof batchData.errors === 'object' ? Object.keys(batchData.errors).length : 0,
    firstUsage: firstBatchUsage ? usageShape(firstBatchUsage) : null
  }
}, null, 2));

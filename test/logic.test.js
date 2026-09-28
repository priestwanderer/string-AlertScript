import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEstimatedTotalCost,
  getQuotaAlerts,
  isMonitorableAccount,
  accountInGroup,
  getGroupName,
  resolveAccountCost,
  shouldFetchUsage,
  usageQuery,
  parseMonitorConfig,
  normalizeMonitorConfig,
  accountMatchesGroup,
  resolveMonitoredGroups,
  summarizeGroupCosts,
  readGroupCatalog,
  buildServerAlerts,
  buildServerFailureAlert,
  formatAlertMessage
} from '../src/logic.js';
import { toStoredConfig } from '../src/config-store.js';

test('uses estimated total cost and does not fall back to balance fields', () => {
  assert.equal(getEstimatedTotalCost({ estimated_total_cost: '123.45', prepaid_balance: 999 }), 123.45);
  assert.equal(getEstimatedTotalCost({ prepaid_balance: 999, quota_limit: 1000 }), null);
});

test('missing 5h window does not trigger a 5h alert', () => {
  const alerts = getQuotaAlerts(
    { seven_day: { utilization: 85 } },
    { id: 'a1', name: 'demo', group_name: 'OpenAI', platform: 'openai' },
    20
  );
  assert.deepEqual(alerts.map((item) => item.windowName), ['7d']);
});

test('nested usage payload is supported', () => {
  const alerts = getQuotaAlerts(
    { data: { five_hour: { utilization: 90 } } },
    { id: 'a1', name: 'demo', group_name: 'OpenAI', platform: 'openai' },
    20
  );
  assert.deepEqual(alerts.map((item) => item.windowName), ['5h']);
});

test('direct 5h UsageProgress payload is supported', () => {
  const alerts = getQuotaAlerts(
    { utilization: 85, resets_at: '2026-09-18T20:00:00Z' },
    { id: 'a1', name: 'demo', group_name: 'OpenAI', platform: 'openai' },
    20
  );
  assert.deepEqual(alerts.map((item) => item.windowName), ['5h']);
});

test('5h and 7d alerts are reported separately', () => {
  const alerts = getQuotaAlerts(
    {
      five_hour: { utilization: 90 },
      seven_day: { remaining_percent: 10 }
    },
    { id: 'a1', name: 'demo', group_name: 'OpenAI', platform: 'openai' },
    20
  );
  assert.deepEqual(alerts.map((item) => item.windowName), ['5h', '7d']);
});

test('disabled and unschedulable accounts are skipped', () => {
  assert.equal(isMonitorableAccount({ status: 'disabled' }), false);
  assert.equal(isMonitorableAccount({ schedulable: false }), false);
  assert.equal(isMonitorableAccount({ status: 'active', schedulable: true }), true);
});

test('projects estimated total cost from the 7d window and keeps explicit fields', () => {
  assert.equal(getEstimatedTotalCost({
    data: { seven_day: { utilization: 25, window_stats: { cost: 10, standard_cost: 1 } } },
    prepaid_balance: 999
  }), 40);
  assert.equal(getEstimatedTotalCost({
    seven_day: { utilization: 0, window_stats: { cost: 10 } },
    quota_limit: 1000
  }), null);
  assert.equal(getEstimatedTotalCost({
    estimated_total_cost: 5,
    seven_day: { utilization: 50, window_stats: { cost: 10 } }
  }), 5);
});

test('a successful usage response without an estimate contributes zero', () => {
  const account = { platform: 'openai', type: 'oauth', groups: [{ name: 'OpenAI' }] };
  const usage = { seven_day: { utilization: 0, window_stats: { cost: 0 } } };
  assert.deepEqual(resolveAccountCost(account, usage), { include: true, cost: 0, missing: false });
});

test('a failed usage fetch is missing unless the account already has an explicit cost', () => {
  const account = { platform: 'grok', type: 'oauth' };
  assert.equal(resolveAccountCost(account, null, { fetchFailed: true }).missing, true);
  assert.equal(resolveAccountCost({ ...account, estimated_cost: '12' }, null, { fetchFailed: true }).missing, false);
});

test('accounts the admin UI does not query do not require usage', () => {
  const account = { platform: 'openai', type: 'apikey' };
  assert.equal(shouldFetchUsage(account), false);
  assert.deepEqual(resolveAccountCost(account, null, { fetchFailed: true }), {
    include: false,
    cost: 0,
    missing: false
  });
});

test('usage source follows the admin auto-load split', () => {
  assert.equal(usageQuery({ platform: 'anthropic', type: 'oauth' }), '?source=passive');
  assert.equal(usageQuery({ platform: 'anthropic', type: 'setup-token' }), '?source=passive');
  assert.equal(usageQuery({ platform: 'openai', type: 'oauth' }), '');
  assert.equal(usageQuery({ platform: 'grok', type: 'oauth' }), '');
  assert.equal(shouldFetchUsage({ platform: 'gemini', type: 'apikey' }), true);
  assert.equal(shouldFetchUsage({ platform: 'anthropic', type: 'apikey' }), false);
  assert.equal(shouldFetchUsage({ platform: 'grok', type: 'oauth' }), true);
});

test('group membership reads groups[].name', () => {
  const account = { groups: [{ name: 'rotation' }, { name: 'grok' }] };
  assert.equal(getGroupName(account), 'rotation');
  assert.equal(accountInGroup(account, 'grok'), true);
  assert.equal(accountInGroup({ group_name: 'OpenAI' }, 'OpenAI'), true);
});

test('server address comes from env and is not given a built-in default', () => {
  const config = parseMonitorConfig({
    SUB2API_EMAIL: 'a@example.com',
    SUB2API_PASSWORD: 'secret'
  });
  assert.equal(config.servers[0].baseUrl, '');
  assert.equal(config.servers[0].settings.baseUrl, 'SUB2API_BASE_URL');
});

test('multiple servers keep their own address, name, and group', () => {
  const config = parseMonitorConfig({
    SUB2API_SERVERS: 'main, backup',
    SUB2API_SERVER_MAIN_NAME: '主服务器',
    SUB2API_SERVER_MAIN_BASE_URL: 'http://10.0.0.1:8080/',
    SUB2API_SERVER_MAIN_EMAIL: 'a@example.com',
    SUB2API_SERVER_MAIN_PASSWORD: 'secret',
    SUB2API_SERVER_BACKUP_BASE_URL: 'http://10.0.0.2:8080',
    SUB2API_SERVER_BACKUP_EMAIL: 'b@example.com',
    SUB2API_SERVER_BACKUP_PASSWORD: 'secret'
  });
  assert.deepEqual(config.servers.map((server) => server.id), ['main', 'backup']);
  assert.equal(config.servers[0].baseUrl, 'http://10.0.0.1:8080');
  assert.equal(config.servers[0].name, '主服务器');
  assert.equal(config.servers[1].name, '10.0.0.2:8080');
});

test('hourly check interval defaults to 60 minutes', () => {
  assert.equal(parseMonitorConfig({}).checkIntervalMinutes, 60);
  assert.equal(parseMonitorConfig({ CHECK_INTERVAL_MINUTES: '30' }).checkIntervalMinutes, 30);
});

test('all-account balance is independent from selected groups', () => {
  const config = parseMonitorConfig({
    MONITOR_ALL_ACCOUNTS: 'true',
    SUB2API_SERVERS: 'japan,usa',
    SUB2API_SERVER_JAPAN_MONITOR_ALL_ACCOUNTS: 'false',
    SUB2API_SERVER_JAPAN_GROUP_SCOPE: 'selected',
    SUB2API_SERVER_JAPAN_GROUPS: 'rotation, grok'
  });
  assert.equal(config.monitorAllAccounts, undefined);
  assert.equal(config.servers[0].monitorAllAccounts, false);
  assert.equal(config.servers[1].monitorAllAccounts, true);
  assert.equal(config.servers[0].groupScope, 'selected');
  assert.deepEqual(config.servers[0].groups.map((group) => group.name), ['rotation', 'grok']);

  const result = {
    allEstimatedCost: 100,
    groupCosts: [
      { id: 3, name: 'rotation', estimatedCost: 80 },
      { id: null, name: 'grok', estimatedCost: 900 }
    ],
    quotaAlerts: []
  };
  const alerts = buildServerAlerts(
    { id: 'japan', name: '日本站', monitorAllAccounts: false },
    result,
    { estimatedCostThreshold: 500 }
  );
  assert.deepEqual(alerts.map((alert) => alert.key), ['japan:group:3']);
  assert.match(alerts[0].text, /【日本站】分组「rotation」总余额：80/);

  const usa = buildServerAlerts(
    { id: 'usa', name: '美国站', monitorAllAccounts: true },
    { allEstimatedCost: 80, groupCosts: [], quotaAlerts: [] },
    { estimatedCostThreshold: 500 }
  );
  assert.deepEqual(usa.map((alert) => alert.key), ['usa:all-estimated-cost']);

  const legacy = normalizeMonitorConfig({
    monitorAllAccounts: false,
    servers: [
      { id: 'japan', baseUrl: 'http://10.0.0.1' },
      { id: 'usa', baseUrl: 'http://10.0.0.2', monitorAllAccounts: true }
    ]
  });
  assert.equal(legacy.servers[0].monitorAllAccounts, false);
  assert.equal(legacy.servers[1].monitorAllAccounts, true);
  const stored = toStoredConfig(legacy);
  assert.equal(Object.hasOwn(stored, 'monitorAllAccounts'), false);
  assert.equal(stored.servers[0].monitorAllAccounts, false);
  assert.equal(stored.servers[1].monitorAllAccounts, true);
});

test('estimated cost threshold belongs to each server', () => {
  const config = parseMonitorConfig({
    ESTIMATED_COST_THRESHOLD: '500',
    SUB2API_SERVERS: 'japan,usa',
    SUB2API_SERVER_USA_ESTIMATED_COST_THRESHOLD: '1200'
  });
  assert.equal(config.estimatedCostThreshold, undefined);
  assert.equal(config.servers[0].estimatedCostThreshold, 500);
  assert.equal(config.servers[1].estimatedCostThreshold, 1200);

  const result = {
    allEstimatedCost: 800,
    groupCosts: [{ id: 3, name: 'rotation', estimatedCost: 700 }],
    quotaAlerts: []
  };
  assert.deepEqual(buildServerAlerts(config.servers[0], result, {}).map((alert) => alert.key), []);
  assert.deepEqual(
    buildServerAlerts({ ...config.servers[1], name: '美国站' }, result, {}).map((alert) => alert.key),
    ['usa:all-estimated-cost', 'usa:group:3']
  );

  const legacy = normalizeMonitorConfig({
    estimatedCostThreshold: 300,
    servers: [
      { id: 'japan', baseUrl: 'http://10.0.0.1' },
      { id: 'usa', baseUrl: 'http://10.0.0.2', estimatedCostThreshold: 900 }
    ]
  });
  assert.equal(legacy.servers[0].estimatedCostThreshold, 300);
  assert.equal(legacy.servers[1].estimatedCostThreshold, 900);
  const stored = toStoredConfig(legacy);
  assert.equal(Object.hasOwn(stored, 'estimatedCostThreshold'), false);
  assert.equal(stored.servers[0].estimatedCostThreshold, 300);
});

test('group membership matches id or name and all-scope discovers account groups', () => {
  const rotation = { id: 'a1', groups: [{ id: 3, name: 'rotation' }] };
  const legacy = { id: 'a2', group_name: 'grok' };
  assert.equal(accountMatchesGroup(rotation, { id: 3, name: 'renamed' }), true);
  assert.equal(accountMatchesGroup(legacy, { id: null, name: 'grok' }), true);
  assert.equal(accountMatchesGroup(rotation, { id: 9, name: 'other' }), false);

  const groups = resolveMonitoredGroups({ groupScope: 'all' }, [rotation, legacy]);
  assert.deepEqual(groups.map((group) => group.name), ['grok', 'rotation']);
  const costs = summarizeGroupCosts([
    { account: rotation, estimatedCost: 40 },
    { account: legacy, estimatedCost: 10 }
  ], groups);
  assert.equal(costs.find((group) => group.name === 'rotation').estimatedCost, 40);
});

test('group catalog reads the admin groups payload', () => {
  const groups = readGroupCatalog({ data: { groups: [{ id: 1, name: 'rotation', platform: 'openai' }, { name: 'rotation' }] } });
  assert.deepEqual(groups, [{ id: 1, name: 'rotation', platform: 'openai' }]);
});

test('monitor config rejects an unknown group scope', () => {
  assert.throws(
    () => normalizeMonitorConfig({
      servers: [{ id: 'japan', baseUrl: 'http://10.0.0.1', groupScope: 'openai' }]
    }),
    /分组范围只能是 all 或 selected/
  );
});

test('alerts are labeled and keyed by server', () => {
  const server = { id: 'main', name: '主服务器' };
  const alerts = buildServerAlerts(server, {
    allEstimatedCost: 100,
    groupCosts: [],
    quotaAlerts: [{
      accountId: '7',
      accountName: 'demo',
      groupName: 'rotation',
      platformName: 'openai',
      windowName: '5h',
      remainingPercent: 10
    }]
  }, { estimatedCostThreshold: 500 });
  assert.deepEqual(alerts.map((alert) => alert.key), ['main:all-estimated-cost', 'main:quota:7:5h']);
  assert.match(formatAlertMessage(alerts), /【主服务器】所有账号总余额/);
  assert.match(formatAlertMessage(alerts), /【主服务器】单账号额度不足：demo/);
  assert.match(buildServerFailureAlert({ id: 'backup', name: '备用服务器' }, '登录失败').text, /【备用服务器】巡检失败：登录失败/);
});

test('a server can keep its config while monitoring is off', () => {
  const config = normalizeMonitorConfig({
    servers: [
      { id: 'japan', name: '日本站', baseUrl: 'http://10.0.0.1', enabled: false },
      { id: 'usa', baseUrl: 'http://10.0.0.2' }
    ]
  });
  assert.equal(config.servers[0].enabled, false);
  assert.equal(config.servers[1].enabled, true);
  assert.equal(config.servers[0].baseUrl, 'http://10.0.0.1');
  assert.equal(toStoredConfig(config).servers[0].enabled, false);
  assert.equal(toStoredConfig(config).servers[1].enabled, true);

  const fromEnv = parseMonitorConfig({
    SUB2API_SERVERS: 'main,backup',
    SUB2API_SERVER_MAIN_BASE_URL: 'http://10.0.0.1',
    SUB2API_SERVER_BACKUP_BASE_URL: 'http://10.0.0.2',
    SUB2API_SERVER_BACKUP_ENABLED: 'off'
  });
  assert.equal(fromEnv.servers[0].enabled, true);
  assert.equal(fromEnv.servers[1].enabled, false);

  assert.throws(
    () => normalizeMonitorConfig({ servers: [{ id: 'japan', enabled: 'maybe' }] }),
    /监控开关 不是有效布尔值/
  );
});

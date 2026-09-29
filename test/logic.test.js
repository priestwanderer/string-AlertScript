import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEstimatedTotalCost,
  getQuotaAlerts,
  isMonitorableAccount,
  accountInGroup,
  getGroupName,
  getGroupNames,
  resolveAccountCost,
  shouldFetchUsage,
  usageQuery,
  parseMonitorConfig,
  normalizeMonitorConfig,
  accountMatchesGroup,
  resolveMonitoredGroups,
  summarizeGroupCosts,
  readGroupCatalog,
  accountListQuery,
  accountListKeepsMembership,
  attachGroupCatalog,
  buildServerAlerts,
  buildServerFailureAlert,
  buildMonitorView,
  getUsedCost,
  getUsageUpdatedAt,
  formatAlertMessage,
  createInspectionGate
} from '../src/logic.js';
import { toStoredConfig } from '../src/config-store.js';

test('uses estimated total cost and does not fall back to balance fields', () => {
  assert.equal(getEstimatedTotalCost({ estimated_total_cost: '123.45', prepaid_balance: 999 }), 123.45);
  assert.equal(getEstimatedTotalCost({ prepaid_balance: 999, quota_limit: 1000 }), null);
  assert.equal(getUsedCost({ seven_day: { utilization: 25, window_stats: { cost: 10 } } }), 10);
  assert.equal(getUsedCost({ estimated_total_cost: 5, prepaid_balance: 9 }), null);
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
  for (const key of ['data', 'usage']) {
    const alerts = getQuotaAlerts(
      { [key]: { five_hour: { utilization: 90 } } },
      { id: 'a1', name: 'demo', group_name: 'OpenAI', platform: 'openai' },
      20
    );
    assert.deepEqual(alerts.map((item) => item.windowName), ['5h']);
    assert.equal(alerts[0].remainingPercent, 10);
  }
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

test('quota percentages keep their units across the one-percent boundary', () => {
  for (const value of [0, 0.1, 0.5, 0.8, 0.9, 1, 1.01, 2, 80, 80.1, 85, 100]) {
    for (const utilization of [value, String(value)]) {
      for (const [usage, windowName] of [
        [{ five_hour: { utilization } }, '5h'],
        [{ seven_day: { utilization } }, '7d'],
        [{ windows: { weekly: { used_percent: utilization } } }, '7d'],
        [{ seven_day_utilization: utilization }, '7d'],
        [{ data: { utilization } }, '5h'],
        [{ data: { usage: { seven_day: { utilization } } } }, '7d'],
        [{ utilization }, '5h']
      ]) {
        const alerts = getQuotaAlerts(usage, {}, 20);
        assert.deepEqual(alerts.map(({ windowName, remainingPercent }) => ({ windowName, remainingPercent })),
          value > 80 ? [{ windowName, remainingPercent: 100 - value }] : [], JSON.stringify(usage));
      }
    }
  }
});

test('explicit remaining percentages below one percent still trigger alerts', () => {
  for (const value of [0, 0.1, 0.5, 0.9, 1, 19.9, 20]) {
    for (const remaining of [value, String(value)]) {
      for (const usage of [
        { seven_day: { remaining_percent: remaining } },
        { seven_day: { remainingPercent: remaining } },
        { seven_day_remaining_percent: remaining }
      ]) {
        const alerts = getQuotaAlerts(usage, {}, 20);
        assert.deepEqual(alerts.map((alert) => alert.remainingPercent), value < 20 ? [value] : []);
      }
    }
  }
});

test('reset countdowns and missing percentages are not quota measurements', () => {
  for (const usage of [
    null, undefined, {}, { remaining_seconds: 0 }, { remaining_seconds: 600, window_seconds: 18000 },
    { five_hour: { remaining_seconds: 0 } }, { seven_day: {} },
    { seven_day: { utilization: null } }, { seven_day: { utilization: '' } },
    { seven_day: { utilization: 'unknown' } }, { seven_day: { utilization: NaN } }
  ]) {
    assert.deepEqual(getQuotaAlerts(usage, {}, 20), [], JSON.stringify(usage));
  }
});

test('one-percent screenshot scenario stays healthy through view and notification logic', () => {
  const account = { id: 269, name: 'demo', platform: 'openai', type: 'oauth', groups: [{ name: 'primary' }] };
  const usage = { seven_day: { utilization: 1, window_stats: { cost: 5.4068 } } };
  const record = { account, estimatedCost: getEstimatedTotalCost(usage), usedCost: getUsedCost(usage), quotaAlerts: getQuotaAlerts(usage, account, 20) };
  const server = { id: 'test', name: 'test', estimatedCostThreshold: 500, monitorAllAccounts: true, groupScope: 'all' };
  const result = { allEstimatedCost: record.estimatedCost, accountCount: 1, records: [record], groupCosts: [{ name: 'primary', estimatedCost: record.estimatedCost }], quotaAlerts: record.quotaAlerts };
  assert.equal(record.estimatedCost, 540.68);
  assert.equal(record.usedCost, 5.4068);
  assert.equal(getQuotaAlerts(usage, account, 100)[0].remainingPercent, 99);
  assert.equal(buildMonitorView(server, result).urgentAccountCount, 0);
  assert.deepEqual(buildMonitorView(server, result).groups, []);
  assert.deepEqual(buildServerAlerts(server, result, {}), []);
});

test('usage timestamps come from the API and never fall back to collection time', () => {
  const timestamp = '2026-09-29T10:49:01+08:00';
  const iso = '2026-09-29T02:49:01.000Z';
  for (const usage of [{ updated_at: timestamp }, { data: { updated_at: timestamp } }, { usage: { updatedAt: timestamp } }, { data: { usage: { updated_at: timestamp } } }]) {
    assert.equal(getUsageUpdatedAt(usage), iso);
  }
  for (const usage of [null, {}, { updated_at: '' }, { updated_at: 'invalid' }, { updated_at: 0 }]) {
    assert.equal(getUsageUpdatedAt(usage), null);
  }
});

test('monitor freshness reports the oldest usage time and accounts with unknown timestamps', () => {
  const server = { id: 'test', name: 'test', estimatedCostThreshold: 500, groupScope: 'all' };
  const makeRecord = (id, usageUpdatedAt) => ({
    account: { id, name: `account-${id}`, groups: [{ name: 'primary' }] },
    estimatedCost: 100, usedCost: 90, usageUpdatedAt,
    quotaAlerts: [{ windowName: '7d', remainingPercent: 10 }]
  });
  const records = [makeRecord(1, '2026-09-29T10:49:01+08:00'), makeRecord(2, '2026-09-29T02:00:00Z'), makeRecord(3, null), makeRecord(4, 'invalid')];
  const result = { allEstimatedCost: 400, accountCount: 4, records, groupCosts: [{ name: 'primary', estimatedCost: 400 }] };
  const view = buildMonitorView(server, result);
  assert.equal(view.usageUpdatedAt, '2026-09-29T02:00:00.000Z');
  assert.equal(view.usageTimestampMissingCount, 2);
  assert.equal(view.groups[0].accounts[0].usageUpdatedAt, '2026-09-29T02:49:01.000Z');
  assert.equal(view.groups[0].accounts[2].usageUpdatedAt, null);
  assert.equal(buildMonitorView(server, { ...result, records: [] }).usageUpdatedAt, null);
  assert.equal(buildMonitorView(server, { ...result, records: [makeRecord(1, null)] }).usageTimestampMissingCount, 1);
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

test('a successful usage response without an estimate stays unknown', () => {
  const account = { platform: 'openai', type: 'oauth', groups: [{ name: 'OpenAI' }] };
  const usage = { seven_day: { utilization: 0, window_stats: { cost: 0 } } };
  assert.deepEqual(resolveAccountCost(account, usage), { include: true, cost: null, missing: false });
});

test('missing monetary data does not create a balance alert but keeps quota alerts', () => {
  const account = { id: 218, name: 'grok-user', platform: 'grok', type: 'oauth', groups: [{ name: 'grok' }] };
  const usage = {
    updated_at: '2026-09-29T03:10:09Z',
    seven_day: { utilization: 17, window_stats: { cost: 0 } }
  };
  const record = {
    account,
    estimatedCost: getEstimatedTotalCost(usage),
    usedCost: getUsedCost(usage),
    quotaAlerts: getQuotaAlerts(usage, account, 20)
  };
  const groupCosts = summarizeGroupCosts([record], [{ name: 'grok' }]);
  const server = { id: 'us', name: '美国站', estimatedCostThreshold: 500, monitorAllAccounts: true, groupScope: 'all' };
  const result = {
    allEstimatedCost: null,
    accountCount: 1,
    records: [record],
    groupCosts,
    quotaAlerts: record.quotaAlerts
  };
  const view = buildMonitorView(server, result);
  assert.equal(record.estimatedCost, null);
  assert.equal(record.usedCost, 0);
  assert.deepEqual(record.quotaAlerts, []);
  assert.equal(groupCosts[0].estimatedCost, null);
  assert.equal(view.all, null);
  assert.deepEqual(view.groups, []);
  assert.equal(view.lowGroupCount, 0);
  assert.equal(view.unknownCostGroupCount, 1);
  assert.deepEqual(buildServerAlerts(server, result, {}), []);
});

test('unknown groups do not hide a real single-account quota alert', () => {
  const account = { id: 218, name: 'grok-user', platform: 'grok', type: 'oauth', groups: [{ name: 'grok' }] };
  const record = {
    account,
    estimatedCost: null,
    usedCost: 0,
    quotaAlerts: [{ accountId: 218, accountName: account.name, groupName: 'grok', platformName: 'grok', windowName: '7d', remainingPercent: 17 }]
  };
  const result = {
    allEstimatedCost: null,
    accountCount: 1,
    records: [record],
    groupCosts: [{ name: 'grok', estimatedCost: null }],
    quotaAlerts: record.quotaAlerts
  };
  const server = { id: 'us', name: '美国站', estimatedCostThreshold: 500, monitorAllAccounts: true, groupScope: 'all' };
  const view = buildMonitorView(server, result);
  const alerts = buildServerAlerts(server, result, {});
  assert.equal(view.urgentAccountCount, 1);
  assert.equal(view.groups[0].urgentCount, 1);
  assert.equal(view.groups[0].usedCost, null);
  assert.equal(view.groups[0].accounts[0].estimatedCost, null);
  assert.equal(view.groups[0].accounts[0].usedCost, null);
  assert.deepEqual(view.groups[0].accounts[0].windows, [{ windowName: '7d', remainingPercent: 17 }]);
  assert.deepEqual(alerts.map((alert) => alert.key), ['us:quota:218:7d']);
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
  assert.match(alerts[0].text, /【日本站】分组「rotation」预计总费用：80/);

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

test('monitor view lists short groups and urgent accounts only', () => {
  const view = buildMonitorView({
    id: 'japan',
    name: '日本站',
    estimatedCostThreshold: 500,
    monitorAllAccounts: true,
    groupScope: 'all'
  }, {
    allEstimatedCost: 100,
    accountCount: 3,
    groupCosts: [
      { id: 3, name: 'rotation', estimatedCost: 80 },
      { id: 9, name: 'grok', estimatedCost: 900 }
    ],
    records: [
      {
        account: { id: 'a1', name: 'low', groups: [{ id: 3, name: 'rotation' }], platform: 'openai' },
        estimatedCost: 40,
        usedCost: 15,
        quotaAlerts: [{ windowName: '5h', remainingPercent: 8 }]
      },
      {
        account: { id: 'a2', name: 'ok', groups: [{ id: 3, name: 'rotation' }], platform: 'openai' },
        estimatedCost: 40,
        usedCost: 5,
        quotaAlerts: []
      },
      {
        account: { id: 'a3', name: 'grok-user', groups: [{ id: 9, name: 'grok' }], platform: 'openai' },
        estimatedCost: 900,
        usedCost: 100,
        quotaAlerts: [{ windowName: '7d', remainingPercent: 4 }]
      }
    ]
  });

  assert.equal(view.lowGroupCount, 1);
  assert.equal(view.urgentAccountCount, 2);
  assert.equal(view.all.estimatedCost, 100);
  assert.equal(view.all.usedCost, 120);
  assert.deepEqual(view.groups.map((group) => group.name), ['rotation', 'grok']);
  assert.equal(view.groups[0].usedCost, 20);
  assert.equal(view.groups[0].accounts.length, 1);
  assert.equal(view.groups[0].accounts[0].name, 'low');
  assert.equal(view.groups[1].low, false);
  assert.equal(view.groups[1].accounts[0].windows[0].windowName, '7d');
});

test('monitor reads share one snapshot and wait out an alert check', async () => {
  const gate = createInspectionGate();
  let releaseCheck;
  const check = gate.checkOnce(() => new Promise((resolve) => {
    releaseCheck = resolve;
  }));
  let reads = 0;
  const first = gate.monitorSnapshot(async () => {
    reads += 1;
    return { servers: ['japan'] };
  });
  const second = gate.monitorSnapshot(async () => {
    reads += 1;
    return { servers: ['usa'] };
  });
  assert.equal(first, second);
  assert.equal(reads, 0);
  assert.throws(() => gate.checkOnce(() => ({ sent: 1 })), (error) => error.statusCode === 409);
  await Promise.resolve();
  releaseCheck({ sent: 0 });
  assert.deepEqual(await first, { servers: ['japan'] });
  assert.equal(reads, 1);
  assert.deepEqual(await check, { sent: 0 });

  let releaseRead;
  const view = gate.monitorSnapshot(() => new Promise((resolve) => {
    releaseRead = () => resolve({ servers: [] });
  }));
  assert.throws(() => gate.checkOnce(() => ({ sent: 1 })), (error) => error.statusCode === 409);
  releaseRead();
  assert.deepEqual(await view, { servers: [] });
  assert.deepEqual(await gate.checkOnce(async () => ({ sent: 2 })), { sent: 2 });
});

test('a failed alert check does not reject the following monitor read', async () => {
  const gate = createInspectionGate();
  const check = gate.checkOnce(async () => {
    throw new Error('upstream failed');
  });
  const view = gate.monitorSnapshot(async () => ({ servers: [1] }));
  await assert.rejects(check, /upstream failed/);
  assert.deepEqual(await view, { servers: [1] });
});

test('monitor reads for different servers run at the same time', async () => {
  const gate = createInspectionGate();
  let releaseJapan;
  const japan = gate.monitorServer('japan', () => new Promise((resolve) => {
    releaseJapan = () => resolve('japan');
  }));
  let usStarted = false;
  const us = gate.monitorServer('us', async () => {
    usStarted = true;
    return 'us';
  });
  assert.equal(await us, 'us');
  assert.equal(usStarted, true);
  assert.throws(() => gate.checkOnce(() => ({ sent: 1 })), (error) => error.statusCode === 409);
  releaseJapan();
  assert.equal(await japan, 'japan');
  assert.deepEqual(await gate.checkOnce(async () => ({ sent: 3 })), { sent: 3 });
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

test('active lite account lists keep ids and can be named from the group catalog', () => {
  assert.equal(
    accountListQuery(1, 100, { status: 'active', lite: true }),
    '/admin/accounts?page=1&page_size=100&status=active&lite=1'
  );
  assert.equal(accountListKeepsMembership([{ id: 1, group_ids: [3] }]), true);
  assert.equal(accountListKeepsMembership([{ id: 1, name: 'plain' }]), false);

  const [account] = attachGroupCatalog(
    [{ id: 'a1', group_ids: [3, 9], status: 'active', schedulable: true }],
    [{ id: 3, name: 'rotation' }]
  );
  assert.deepEqual(getGroupNames(account), ['rotation', '分组#9']);
  assert.equal(accountMatchesGroup(account, { id: 3, name: 'renamed' }), true);
  const [named] = attachGroupCatalog(
    [{ id: 'a2', group_ids: [3], groups: [{ id: 3, name: 'kept' }] }],
    [{ id: 3, name: 'rotation' }]
  );
  assert.deepEqual(getGroupNames(named), ['kept']);
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
  assert.match(formatAlertMessage(alerts), /【主服务器】所有账号预计总费用/);
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

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
  usageQuery
} from '../src/logic.js';

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

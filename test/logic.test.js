import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEstimatedTotalCost,
  getQuotaAlerts,
  isMonitorableAccount
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

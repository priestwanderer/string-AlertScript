import test from 'node:test';
import assert from 'node:assert/strict';
import { cardStatus, summarizeCards, filterCards, moneyNumber, balancePercent, percentText, windowPercent, meterWidth } from '../web/monitor-view.js';

const account = { id: 1, name: 'alpha@example.invalid', platform: 'OpenAI', windows: [{ windowName: '7d', remainingPercent: 0 }] };
const warning = { id: 'japan', name: '日本站', view: { lowGroupCount: 2, urgentAccountCount: 1, groups: [{ name: 'Primary', accounts: [account] }, { name: 'Backup', accounts: [] }] } };
const healthy = { id: 'us', name: '美国站', view: { lowGroupCount: 0, urgentAccountCount: 0, groups: [] } };

test('monitor states distinguish pending, healthy, urgent and stale data', () => {
  assert.equal(cardStatus({}).tone, 'pending');
  assert.equal(cardStatus(healthy).tone, 'healthy');
  assert.equal(cardStatus(warning).tone, 'warning');
  assert.equal(cardStatus({ view: { all: { estimatedCost: 0 } } }).tone, 'warning');
  assert.equal(cardStatus({ error: 'offline' }).label, '读取失败');
  assert.equal(cardStatus({ ...warning, error: 'timeout' }).label, '数据未更新');
  assert.equal(cardStatus({ view: { error: 'offline' } }).label, '读取失败');
});

test('summary uses server-deduplicated account counts, not repeated group rows', () => {
  const summary = summarizeCards([warning, healthy, { id: 'failed', error: 'offline' }]);
  assert.deepEqual(summary, { total: 3, readable: 2, pending: 0, errors: 1, attention: 2, lowGroups: 2, urgentAccounts: 1 });
  assert.equal(summarizeCards([{ id: 'loading' }]).urgentAccounts, null);
  assert.equal(summarizeCards([{ id: 'failed', error: 'offline' }]).lowGroups, null);
  assert.equal(summarizeCards([]).urgentAccounts, 0);
  assert.equal(summarizeCards([{ ...warning, error: 'timeout' }]).urgentAccounts, 1);
});

test('filters combine server, attention and case-insensitive account search without changing source data', () => {
  assert.equal(filterCards([warning, healthy], { serverId: 'us' })[0].id, 'us');
  assert.equal(filterCards([warning, healthy], { attentionOnly: true }).length, 1);
  const result = filterCards([warning, healthy], { query: ' ALPHA@ ' });
  assert.equal(result.length, 1);
  assert.equal(result[0].view.groups.length, 1);
  assert.equal(result[0].view.groups[0].accounts[0].name, account.name);
  assert.equal(warning.view.groups.length, 2);
  assert.equal(filterCards([warning], { query: 'openai' }).length, 1);
  assert.equal(filterCards([warning], { query: 'Primary' })[0].view.groups.length, 1);
  assert.equal(filterCards([warning], { query: '日本站' })[0].view.groups.length, 2);
  assert.deepEqual(filterCards([warning, healthy], { query: 'missing' }), []);
});

test('money and quota displays preserve zero and distinguish unknown values', () => {
  assert.equal(moneyNumber(1234.5), '1,234.50');
  assert.equal(moneyNumber(0), '0.00');
  assert.equal(moneyNumber(null), '--');
  assert.equal(moneyNumber(NaN), '--');
  assert.equal(balancePercent(120, 500), 24);
  assert.equal(balancePercent(1000, 500), 100);
  assert.equal(balancePercent(100, 0), null);
  assert.equal(windowPercent(account, '7d'), 0);
  assert.equal(windowPercent(account, '5h'), null);
  assert.equal(percentText(0), '0%');
  assert.equal(percentText(0.01), '<0.1%');
  assert.equal(percentText(0.5), '0.5%');
  assert.equal(percentText(0.9), '0.9%');
  assert.equal(percentText(1), '1%');
  assert.equal(percentText(99), '99%');
  assert.equal(percentText(99.1), '99.1%');
  assert.equal(percentText(null), '--');
  assert.equal(meterWidth(-10), '0%');
  assert.equal(meterWidth(105), '100%');
});

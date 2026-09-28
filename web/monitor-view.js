export function cardStatus(card) {
  if (card.error || card.view?.error) {
    return { tone: 'error', label: card.view && !card.view.error ? '数据未更新' : '读取失败' };
  }
  if (!card.view) return { tone: 'pending', label: '读取中' };
  if (card.view.all || card.view.lowGroupCount > 0 || card.view.urgentAccountCount > 0) {
    return { tone: 'warning', label: '需关注' };
  }
  return { tone: 'healthy', label: '正常' };
}

export function summarizeCards(cards) {
  const readable = cards.filter((card) => card.view && !card.view.error);
  return {
    total: cards.length,
    readable: readable.length,
    pending: cards.filter((card) => !card.view && !card.error).length,
    errors: cards.filter((card) => card.error || card.view?.error).length,
    attention: cards.filter((card) => ['error', 'warning'].includes(cardStatus(card).tone)).length,
    lowGroups: readable.length || !cards.length
      ? readable.reduce((sum, card) => sum + (card.view.lowGroupCount || 0), 0) : null,
    urgentAccounts: readable.length || !cards.length
      ? readable.reduce((sum, card) => sum + (card.view.urgentAccountCount || 0), 0) : null
  };
}

export function filterCards(cards, { serverId = '', query = '', attentionOnly = false } = {}) {
  const term = query.trim().toLocaleLowerCase();
  const matches = (...values) => values.some((value) => String(value ?? '').toLocaleLowerCase().includes(term));
  return cards.flatMap((card) => {
    if (serverId && card.id !== serverId) return [];
    if (attentionOnly && !['error', 'warning'].includes(cardStatus(card).tone)) return [];
    if (!term || matches(card.name, card.id, card.view?.name)) return [card];
    const groups = (card.view?.groups || []).flatMap((group) => {
      if (matches(group.name)) return [group];
      const accounts = (group.accounts || []).filter((account) => matches(account.name, account.platform));
      return accounts.length ? [{ ...group, accounts }] : [];
    });
    return groups.length ? [{ ...card, view: { ...card.view, groups } }] : [];
  });
}

const currency = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function moneyNumber(value) {
  return Number.isFinite(value) ? currency.format(value) : '--';
}

export function balancePercent(cost, threshold) {
  if (!Number.isFinite(cost) || !Number.isFinite(threshold) || threshold <= 0) return null;
  return Math.max(0, Math.min(100, (cost / threshold) * 100));
}

export function percentText(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '--';
}

export function windowPercent(account, name) {
  const window = (account.windows || []).find((item) => item.windowName === name);
  return Number.isFinite(window?.remainingPercent) ? window.remainingPercent : null;
}

export function meterWidth(value) {
  return `${Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0}%`;
}

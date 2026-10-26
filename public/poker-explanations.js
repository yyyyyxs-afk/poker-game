// 只解释服务器公开的金额，不裁决规则或估计未公开的底牌。
const PokerExplanations = (() => {
  const number = value => Number(value).toLocaleString('zh-CN');
  const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
  function actionAmounts(state, me, raiseTo) {
    const call = Math.min(me.chips, Math.max(0, state.currentBet - me.roundBet));
    const max = me.roundBet + me.chips;
    const total = Math.max(me.roundBet, Math.min(max, Number(raiseTo) || 0));
    return { call, afterCall: me.chips - call, max, total,
      extra: total - me.roundBet, remaining: me.chips - (total - me.roundBet),
      frozen: me.frozen || 0 };
  }
  function resultBreakdown(result, entry) {
    let squidNet = 0;
    for (const event of result.squidEvents || []) {
      if (event.type !== 'payment') continue;
      if (event.from === entry.name) squidNet -= event.total;
      if (event.to.includes(entry.name)) squidNet += event.payment ?? event.bb;
    }
    const awards = (result.pots || []).flatMap(pot => pot.winners).filter(w => w.name === entry.name);
    const returned = awards.every(w => Number.isFinite(w.amountWon))
      ? awards.reduce((sum, w) => sum + w.amountWon, 0) : null;
    return { squidNet, pokerNet: entry.delta - squidNet, returned };
  }
  return { number, signed, actionAmounts, resultBreakdown };
})();
if (typeof module !== 'undefined') module.exports = PokerExplanations;

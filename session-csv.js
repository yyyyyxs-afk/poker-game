// Only public, settled session fields enter the export.
function cell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[\s]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function buildSessionCsv(room, entries, at = new Date()) {
  const header = ['房号','导出时间（UTC）','昵称','累计买入（筹码）','结算筹码','净盈亏（筹码）','手数','胜场','状态','口径'];
  const rows = entries.map(e => [room.code, at.toISOString(), e.name, e.buyIn,
    e.left ? e.buyIn + e.pl : e.chips, e.pl, e.hands, e.wins,
    e.left ? '已离场' : '在场', '截至导出时已结算；离场为离场时筹码']);
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
module.exports = { buildSessionCsv };

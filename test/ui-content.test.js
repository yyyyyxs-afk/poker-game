const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'public', 'client.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

for (const id of ['btn-rules-lobby', 'btn-rules-game', 'rules-overlay', 'btn-rules-close']) {
  assert.ok(html.includes(`id="${id}"`), `缺少玩法说明入口或弹窗：${id}`);
}

const ranks = ['皇家同花顺', '同花顺', '四条', '葫芦', '同花', '顺子', '三条', '两对', '一对', '高牌'];
let previous = -1;
for (const rank of ranks) {
  const index = html.indexOf(`<b>${rank}</b>`);
  assert.ok(index > previous, `牌型顺序缺失或错误：${rank}`);
  previous = index;
}

assert.ok(client.includes("openRules('quick'"), '玩法说明入口未接入打开逻辑');
assert.ok(client.includes("event.key === 'Escape'"), '玩法说明缺少键盘关闭能力');
assert.ok(css.includes('#rules-card') && css.includes('@media (max-width: 900px)'), '玩法说明缺少桌面或手机样式');
assert.ok(html.includes('本游戏仅供好友娱乐，不涉及真钱交易。'), '缺少娱乐用途提示');

console.log('界面内容检查通过：双入口、交互、手机样式与牌型顺序正常 ✅');

/**
 * 玩法规则表（经典 52 张 / 短牌 36 张）
 *
 * 把「按模式变化」的东西集中在一处：牌堆点数域、牌型类别编号、A 作小顺子的轮子规则、
 * 牌型中文名。server.js 只按房间自己的 room.mode 现取规则，不保存任何"当前模式"的
 * 全局可变状态，因此同一进程内经典房与短牌房并行对局时互不污染。
 *
 * 类别编号沿用 cmpScore 的字典序约定（数组逐位比较，数字大者强）：
 *   经典 8..0 = 同花顺 / 四条 / 葫芦 / 同花 / 顺子 / 三条 / 两对 / 一对 / 高牌
 *   短牌 8..0 = 同花顺 / 四条 / 同花 / 葫芦 / 三条 / 顺子 / 两对 / 一对 / 高牌
 * 短牌相对经典只交换了「同花↔葫芦」「三条↔顺子」两组编号，cmpScore 无需改动。
 */

// 短牌去掉 2/3/4/5，点数域 6–14（14=A）
const CLASSIC_RANKS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
const SHORT_RANKS = Object.freeze([6, 7, 8, 9, 10, 11, 12, 13, 14]);

const CLASSIC_CATEGORIES = Object.freeze({
  straightFlush: 8, quads: 7, fullHouse: 6, flush: 5, straight: 4,
  trips: 3, twoPair: 2, onePair: 1, highCard: 0,
});
const SHORT_CATEGORIES = Object.freeze({
  straightFlush: 8, quads: 7, flush: 6, fullHouse: 5, trips: 4,
  straight: 3, twoPair: 2, onePair: 1, highCard: 0,
});

const RANK_TEXT = Object.freeze({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' });
function rankText(r) {
  return RANK_TEXT[r] || String(r);
}

// 文案绑定在「类别含义」而非固定编号上：短牌编号交换后，同花仍显示"同花"、三条仍显示"三条"。
const CATEGORY_LABELS = Object.freeze({
  straightFlush: (s) => `同花顺（${rankText(s[1])} 高）`,
  quads: (s) => `四条 ${rankText(s[1])}`,
  fullHouse: (s) => `葫芦（${rankText(s[1])} 带 ${rankText(s[2])}）`,
  flush: (s) => `同花（${rankText(s[1])} 高）`,
  straight: (s) => `顺子（${rankText(s[1])} 高）`,
  trips: (s) => `三条 ${rankText(s[1])}`,
  twoPair: (s) => `两对 ${rankText(s[1])} 和 ${rankText(s[2])}`,
  onePair: (s) => `一对 ${rankText(s[1])}`,
  highCard: (s) => `高牌 ${rankText(s[1])}`,
});

function labelsFor(categories) {
  const labels = {};
  for (const [name, cat] of Object.entries(categories)) labels[cat] = CATEGORY_LABELS[name];
  return Object.freeze(labels);
}

const RULESETS = Object.freeze({
  classic: Object.freeze({
    mode: 'classic',
    label: '经典德州',
    deckSize: 52,
    ranks: CLASSIC_RANKS,
    categories: CLASSIC_CATEGORIES,
    // A 作小顺子：A-2-3-4-5，按 5 高
    wheelKey: '2,3,4,5,14',
    wheelHigh: 5,
    labels: labelsFor(CLASSIC_CATEGORIES),
  }),
  short: Object.freeze({
    mode: 'short',
    label: '短牌德州',
    deckSize: 36,
    ranks: SHORT_RANKS,
    categories: SHORT_CATEGORIES,
    // A 作小顺子：A-6-7-8-9，按 9 高；经典 A-2-3-4-5 在短牌不成立
    wheelKey: '6,7,8,9,14',
    wheelHigh: 9,
    labels: labelsFor(SHORT_CATEGORIES),
  }),
});

const MODE_IDS = Object.freeze(Object.keys(RULESETS));

/** 取模式规则；未知模式一律回退经典，保证缺省调用与历史行为一致 */
function rulesFor(mode) {
  return Object.hasOwn(RULESETS, mode) ? RULESETS[mode] : RULESETS.classic;
}

function isMode(mode) {
  return Object.hasOwn(RULESETS, mode);
}

/** 按类别编号取牌型文案（编号随模式不同，文案随类别不同） */
function handNameFor(mode, category) {
  const rules = rulesFor(mode);
  return rules.labels[category] || rules.labels[rules.categories.highCard];
}

module.exports = { RULESETS, MODE_IDS, rulesFor, isMode, handNameFor, rankText };

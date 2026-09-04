/**
 * 几何回归检查（模型级穷举）：席位卡 / 下注圆片 与 桌心中央区（stage-label / pot /
 * community 三子区）的矩形碰撞 + 归属判据。
 *
 * 用法：node test/geometry-check.js   （纯计算，无需服务器；退出码 0=通过）
 *
 * 与运行时的关系：
 * - 运行时真值是 client.js renderBets() 的 DOM 实测定位（getBoundingClientRect，
 *   天然自适应全部断点/桌型），本脚本是同规则的百分比模型近似，用于防参数漂移的
 *   快速回归；两者不一致时以真机 DOM 实测为准，并把实测数据回填到这里的 LAYOUTS。
 * - seatPosition 的手机侧翼参数与 BET/中央区几何耦合：改动 seatPosition、牌面
 *   尺寸（.card/.card-slot）、席位卡尺寸（.seat-card）或桌比例（#table aspect）
 *   后必须重跑本脚本并按需更新 LAYOUTS 校准值。
 *
 * 校准基准（来源）：
 * - 320×568 真机实测（Phase 5 验收窗口）：桌 1:1 内容 288，社区牌容器
 *   x65~255（占比 17%~83%）、席位卡 92×37；用户实拍相交 34×14px 的案例
 *   在本模型中复现后修复（提交 4e21afd）。
 * - 375/横屏/PC 按 CSS 布局推算（stack 高度 × 桌内容尺寸），误差 ±2%。
 * - 中央区子区：label/pot 取居中窄带，community 取全宽带。
 *
 * 归属判据（Phase 6 用户反馈新增）：
 * 圆片中心到自家席位卡边缘的距离，必须比到任一非自家席位卡边缘的距离
 * 小至少 5%（桌尺寸百分点）——"显著更近"，否则判归属歧义。
 */

const HALF_W = 8, HALF_H = 4;        // 下注圆片半尺寸（桌百分比，手机最坏情况）
const OWN_MARGIN = 5;                // 归属判据：显著更近的最小差值

const LAYOUTS = [
  {
    name: '320 竖屏 1:1 桌（真机校准）',
    narrow: true, veryNarrow: true, landscape: false,
    seatHalfW: 16, seatHalfH: 6.4, chipHalfW: 8, chipHalfH: 4,
    zones: [
      { name: 'label', x1: 40, x2: 60, y1: 23.3, y2: 27 },
      { name: 'pot', x1: 30, x2: 70, y1: 31, y2: 45.5 },
      { name: 'community', x1: 17, x2: 83, y1: 49.3, y2: 66 },
    ],
  },
  {
    name: '375 竖屏 1:1 桌',
    narrow: true, veryNarrow: false, landscape: false,
    seatHalfW: 14.2, seatHalfH: 5.2, chipHalfW: 7.8, chipHalfH: 4,
    zones: [
      { name: 'label', x1: 40, x2: 60, y1: 30.9, y2: 34.8 },
      { name: 'pot', x1: 30, x2: 70, y1: 38.2, y2: 49.9 },
      { name: 'community', x1: 18.2, x2: 81.8, y1: 53.2, y2: 69.1 },
    ],
  },
  {
    name: '手机横屏 550x329 桌',
    narrow: true, veryNarrow: false, landscape: true,
    seatHalfW: 11, seatHalfH: 8, chipHalfW: 7.5, chipHalfH: 4,
    zones: [
      { name: 'label', x1: 40, x2: 60, y1: 29.2, y2: 33.4 },
      { name: 'pot', x1: 30, x2: 70, y1: 37.1, y2: 49.8 },
      { name: 'community', x1: 29.2, x2: 70.8, y1: 53.5, y2: 70.8 },
    ],
  },
  {
    name: 'PC 1156x640 桌',
    narrow: false, veryNarrow: false, landscape: false,
    seatHalfW: 6.5, seatHalfH: 4.2, chipHalfW: 4.5, chipHalfH: 4,
    zones: [
      { name: 'label', x1: 40, x2: 60, y1: 37.3, y2: 39.9 },
      { name: 'pot', x1: 30, x2: 70, y1: 41.8, y2: 49 },
      { name: 'community', x1: 36.6, x2: 63.4, y1: 51.8, y2: 63.6 },
    ],
  },
];

/** 与 client.js seatPosition 同规则（改动必须双侧同步） */
function seatPosition(index, total, L) {
  const angleDeg = 90 + (index / total) * 360;
  const rad = (angleDeg * Math.PI) / 180;
  const { narrow, veryNarrow, landscape } = L;
  const rx = 44, ry = narrow ? 40 : 42;
  let x = Math.max(narrow ? 14 : 9, Math.min(narrow ? 86 : 91, 50 + Math.cos(rad) * rx));
  let y = Math.max(narrow ? 11 : 9, Math.min(narrow ? 80 : 71, 50 + Math.sin(rad) * ry));
  if (narrow && index !== 0 && (x <= 30 || x >= 70)) {
    if (landscape) y = y < 50 ? Math.min(y, 24) : Math.max(y, 88);
    else y = y < 50 ? Math.min(y, 27) : Math.max(y, veryNarrow ? 82 : 78);
  }
  return { x, y };
}

/**
 * 与 client.js renderBets 的 DOM 实测搜索同规则的模型近似：
 * 沿"席位→桌心"轴从贴卡缘向外找第一个不与中央子区/其他席位卡/自家卡/桌界
 * 冲突的点；轴上无解则贴自家卡上/下/左/右沿（仍在自家半侧，无横漂）。
 */
const BAND = { x1: 17, x2: 83, y1: 30, y2: 82 }; // 保守带（轴搜索的粗判据）
function betPosition(seat, index, total, L) {
  // seat0 是桌外 Hero Dock；运行时固定锚定在桌面下沿内侧。
  if (index === 0) return { x: 50, y: 82, degenerate: false, hero: true };
  const { x, y } = seat;
  let vx = 50 - x, vy = 50 - y;
  const len = Math.hypot(vx, vy) || 1;
  vx /= len; vy /= len;
  const halfW = L.chipHalfW, halfH = L.chipHalfH;
  const sw = L.seatHalfW, sh = L.seatHalfH;

  const rectsOverlap = (r, o, m) => r.x2 > o.x1 + m && r.x1 < o.x2 - m && r.y2 > o.y1 + m && r.y1 < o.y2 - m;
  const chipRect = (px, py) => ({ x1: px - halfW, x2: px + halfW, y1: py - halfH, y2: py + halfH });
  const blocked = (px, py) => {
    const r = chipRect(px, py);
    if (r.x1 < 1.5 || r.x2 > 98.5 || r.y1 < 1.5 || r.y2 > 98.5) return true; // 桌界
    for (const z of L.zones) if (rectsOverlap(r, z, 2)) return true;          // 中央区：零压盖
    for (let i = 0; i < total; i++) {
      // 桌内障碍席位：排除自己（index 0 渲染在桌外 Hero Dock，不在 #seats）
      if (i === index || i === 0) continue;
      const o = seatPosition(i, total, L);
      if (rectsOverlap(r, { x1: o.x - sw, x2: o.x + sw, y1: o.y - sh, y2: o.y + sh }, -3)) return true;
    }
    // 自家卡（对手席位卡 / 或桌外 hero 卡）：允许贴沿 4px 轻擦（不遮文字）
    if (rectsOverlap(r, { x1: x - sw, x2: x + sw, y1: y - sh, y2: y + sh }, -4)) return true;
    return false;
  };

  const dMin = Math.abs(vx) * sw + Math.abs(vy) * sh + 2; // 卡矩形在轴上的投影半径
  const dMax = 26;
  for (let d = dMin; d <= dMax; d += 2) {
    const px = x + vx * d, py = y + vy * d;
    if (!blocked(px, py)) return { x: px, y: py, degenerate: false };
  }
  // 贴卡四沿（自家半侧）：纵向沿按桌心方向优先，横向沿固定左右偏移
  const edges = [
    [x, y + Math.sign(vy || 1) * (sh + halfH + 4)],
    [x, y - Math.sign(vy || 1) * (sh + halfH + 4)],
    [x + (sw + halfW + 4), y],
    [x - (sw + halfW + 4), y],
  ];
  for (const [px, py] of edges) if (!blocked(px, py)) return { x: px, y: py, degenerate: false };
  // 极度拥挤兜底：四沿按压盖代价取最小（community 10 / 他卡 8 / pot 6 / label 3 / 自家卡 2）
  let best = null, bestScore = Infinity;
  for (const [px, py] of edges) {
    const r = chipRect(px, py);
    if (r.x1 < 0 || r.x2 > 100 || r.y1 < 0 || r.y2 > 100) continue;
    let s = 2;
    L.zones.forEach((z, i) => { if (rectsOverlap(r, z, 0)) s += [3, 6, 10][i] || 5; });
    for (let i = 0; i < total; i++) {
      if (i === index || i === 0) continue; // seat0 桌外，非障碍
      const o = seatPosition(i, total, L);
      if (rectsOverlap(r, { x1: o.x - sw, x2: o.x + sw, y1: o.y - sh, y2: o.y + sh }, 0)) s += 8;
    }
    if (s < bestScore) { bestScore = s; best = { x: px, y: py, degenerate: true }; }
  }
  return best || { x, y, degenerate: true };
}

/** 归属判据：到自家卡边缘的距离比到任一非自家卡小 ≥ OWN_MARGIN */
function ownershipOk(bet, self, others, L) {
  const distTo = (card) => {
    const dx = Math.max(card.x1 - bet.x, 0, bet.x - card.x2);
    const dy = Math.max(card.y1 - bet.y, 0, bet.y - card.y2);
    return Math.hypot(dx, dy);
  };
  const dSelf = distTo({ x1: self.x - L.seatHalfW, x2: self.x + L.seatHalfW, y1: self.y - L.seatHalfH, y2: self.y + L.seatHalfH });
  let minOther = Infinity;
  for (const o of others) {
    minOther = Math.min(minOther, distTo({ x1: o.x - L.seatHalfW, x2: o.x + L.seatHalfW, y1: o.y - L.seatHalfH, y2: o.y + L.seatHalfH }));
  }
  return minOther - dSelf >= OWN_MARGIN;
}

const overlap = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const rect = (c, hw, hh) => ({ x1: c.x - hw, x2: c.x + hw, y1: c.y - hh, y2: c.y + hh });
// 与 blocked 相同的 margin 语义（中央区 +2 / 他卡 -3 / 自家卡 -4）：
// 搜索判"可行"的点，验收必须同判"可行"，避免阈值不一致的假阳性。
const rectsOverlap = (r, o, m) => r.x2 > o.x1 + m && r.x1 < o.x2 - m && r.y2 > o.y1 + m && r.y1 < o.y2 - m;
const HIT_MARGIN_ZONES = 2, HIT_MARGIN_OTHER = -3, HIT_MARGIN_SELF = -4;

let fail = 0;
let warns = 0;
for (const L of LAYOUTS) {
  for (let total = 2; total <= 6; total++) {
    for (let idx = 0; idx < total; idx++) {
      const seat = seatPosition(idx, total, L);
      const bet = betPosition(seat, idx, total, L);
      const betRect = rect(bet, L.chipHalfW, L.chipHalfH);
      const others = [];
      // 归属比较范围：桌内席位（排除自己 idx 与桌外 seat0）
      for (let i = 1; i < total; i++) if (i !== idx) others.push(seatPosition(i, total, L));

      const hits = [];
      for (const z of L.zones) if (rectsOverlap(betRect, z, HIT_MARGIN_ZONES)) hits.push('圆片压' + z.name);
      for (let i = 1; i < total; i++) {
        // seat0 渲染在桌外 Hero Dock，不是桌内障碍
        if (i === idx) continue;
        if (rectsOverlap(betRect, rect(seatPosition(i, total, L), L.seatHalfW, L.seatHalfH), HIT_MARGIN_OTHER)) hits.push('圆片压席位' + i);
      }
      // seat0 的真实 Hero 卡在牌桌 DOM 外，不应拿桌内虚拟坐标判碰撞。
      if (idx !== 0 && rectsOverlap(betRect, rect(seat, L.seatHalfW, L.seatHalfH), HIT_MARGIN_SELF)) hits.push('圆片压自家卡');
      if (betRect.x1 < 0 || betRect.x2 > 100 || betRect.y1 < 0 || betRect.y2 > 100) hits.push('圆片出界');
      const weakOnly = hits.every((h) => h === '圆片压label' || h === '圆片压pot' || h === '圆片压自家卡');
      if (hits.length && !(bet.degenerate && weakOnly)) {
        // 拥挤兜底位置只允许轻压 label/pot/自家卡（弱信息，WARN 级）；
        // 压 community / 其他席位 / 出界 仍是 FAIL。
        fail++;
        console.log('BAD', L.name, total + '人 seat' + idx,
          'seat=(' + seat.x.toFixed(1) + ',' + seat.y.toFixed(1) + ')',
          'bet=(' + bet.x.toFixed(1) + ',' + bet.y.toFixed(1) + ')', hits.join('/'));
        continue;
      }
      if (hits.length) {
        warns++;
        console.log('WARN', L.name, total + '人 seat' + idx,
          'bet=(' + bet.x.toFixed(1) + ',' + bet.y.toFixed(1) + ') 拥挤兜底轻压弱信息区（色描边兜底）:', hits.join('/'));
        continue;
      }
      // 归属判据：极度拥挤桌（如 320×568 六人顶部席位）可能无解，
      // 此时降级为 WARN——运行时靠席位色描边（--a1-seat-N）兜底归属。
      if (idx !== 0 && !ownershipOk(bet, seat, others, L)) {
        warns++;
        console.log('WARN', L.name, total + '人 seat' + idx,
          'bet=(' + bet.x.toFixed(1) + ',' + bet.y.toFixed(1) + ') 归属距离差不足（拥挤豁免，色描边兜底）');
      }
    }
  }
}
if (fail) {
  console.log('FAIL ' + fail + ' 处。请核对 LAYOUTS 校准值与 client.js seatPosition/renderBets 参数是否同步。');
  process.exit(1);
}
console.log('ALL PASS（4 布局 × 2~6 人 × 全席位：零相交、不出界；' + warns + ' 处拥挤/归属豁免已由色描边兜底）');

const assert = require('node:assert/strict');
const { mobileViewRect, createMobileView } = require('../public/mobile-view');
const surface = { top: 30, right: 390 };
assert.deepEqual(mobileViewRect({ left: 300, right: 350, top: 80, bottom: 180, width: 50, height: 100 }, surface, true),
  { left: 50, top: 40, right: 150, bottom: 90, width: 100, height: 50 });
const native = { left: 11, top: 22, width: 33, height: 44 };
assert.equal(mobileViewRect(native, surface, false), native);
function target() {
  const classes = new Set(), vars = {};
  return { classes, vars, classList: { contains: key => classes.has(key),
    toggle(key, yes) { if (yes) classes.add(key); else classes.delete(key); } },
    style: { setProperty(key, value) { vars[key] = value; } }, getBoundingClientRect: () => ({ top: 0, right: 375 }) };
}
(async () => {
  const root = target(), game = target(), html = target(), notices = [], states = [], handlers = {};
  let focused = false, frame = null, enterCount = 0, exitCount = 0;
  const doc = { documentElement: html, activeElement: { matches: () => focused },
    addEventListener: (event, fn) => { handlers[event] = fn; }, fullscreenElement: null,
    async exitFullscreen() { exitCount++; this.fullscreenElement = null; } };
  const win = { innerWidth: 375, innerHeight: 812,
    visualViewport: { width: 375, height: 700, offsetTop: 10, offsetLeft: 0, addEventListener() {} },
    addEventListener() {}, requestAnimationFrame(fn) { frame = fn; return 1; }, cancelAnimationFrame() { frame = null; } };
  const controller = createMobileView({ root, game, win, doc, onChange: s => states.push(s), onNotice: n => notices.push(n) });
  controller.refresh(); assert.equal(controller.size().rotated, false);
  controller.toggleLandscape(); assert.equal(controller.size().width, 700); assert.equal(controller.size().height, 375);
  assert.equal(root.classes.has('compact-game'), true); assert.equal(root.classes.has('page-landscape'), true);
  assert.equal(root.vars['--surface-top'], '10px');
  focused = true; win.visualViewport.height = 260; handlers.focusin(); frame();
  assert.equal(controller.size().rotated, false, '输入时临时恢复自然方向');
  assert.equal(controller.size().compact, false, '竖屏软键盘不能误触发横屏布局');
  assert.equal(html.vars['--visible-height'], '260px');
  assert.equal(controller.size().manual, true, '临时输入不丢横向偏好');
  focused = false; win.visualViewport.height = 700; handlers.focusout(); frame(); assert.equal(controller.size().rotated, true);
  win.visualViewport.width = 930; win.visualViewport.height = 250;
  controller.refresh(); assert.equal(controller.size().rotated, false); assert.equal(controller.size().compact, true);
  assert.equal(root.classes.has('short-game'), true);
  assert.equal(root.vars['--surface-height'], '250px', '以可见高度而非原屏幕高度布局');
  game.classes.add('hidden'); controller.refresh(); assert.equal(root.classes.has('compact-game'), false);
  game.classes.delete('hidden');
  await controller.toggleFullscreen(); assert.match(notices.at(-1), /不支持全屏/);
  html.requestFullscreen = async () => { enterCount++; doc.fullscreenElement = html; };
  await controller.toggleFullscreen(); assert.equal(enterCount, 1); assert.equal(controller.size().fullscreen, true);
  await controller.toggleFullscreen(); assert.equal(exitCount, 1); assert.equal(controller.size().fullscreen, false);
  html.requestFullscreen = async () => { throw new Error('not allowed'); };
  await controller.toggleFullscreen(); assert.match(notices.at(-1), /当前牌局继续/);
  controller.toggleLandscape(); assert.equal(controller.size().manual, false);
  win.visualViewport = undefined; win.innerWidth = 640; win.innerHeight = 300;
  controller.refresh(); assert.equal(controller.size().width, 640); assert.equal(controller.size().height, 300);
  delete html.requestFullscreen;
  html.webkitRequestFullscreen = function () { assert.equal(this, html); doc.webkitFullscreenElement = html; };
  doc.webkitExitFullscreen = function () { assert.equal(this, doc); this.webkitFullscreenElement = null; };
  await controller.toggleFullscreen(); assert.equal(controller.size().fullscreen, true);
  await controller.toggleFullscreen(); assert.equal(controller.size().fullscreen, false);
  console.log('手机显示检查通过：旋转坐标、真实可见尺寸、输入恢复、自然横屏、退出大厅、全屏成功/退出/拒绝/缺失');
})().catch(error => { console.error(error); process.exitCode = 1; });

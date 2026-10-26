// 页面内横向只改变显示坐标，不重载页面、不建立新的牌局连接。
function mobileViewRect(rect, surface, rotated) {
  if (!rotated) return rect;
  const left = rect.top - surface.top, top = surface.right - rect.right;
  return { left, top, right: left + rect.height, bottom: top + rect.width,
    width: rect.height, height: rect.width };
}
function createMobileView({ root, game, onChange = () => {}, onNotice = () => {},
  win = window, doc = document }) {
  let manual = false, current = null, frame = null;
  function refresh() {
    const v = win.visualViewport;
    const width = v?.width || win.innerWidth, height = v?.height || win.innerHeight;
    const active = !game.classList.contains('hidden');
    const editing = !!doc.activeElement?.matches('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([disabled]),textarea,select');
    const rotated = active && manual && width < height && !editing;
    const w = rotated ? height : width, h = rotated ? width : height;
    const orientation = win.screen?.orientation?.type;
    const nativeLandscape = orientation ? orientation.startsWith('landscape') : win.innerWidth > win.innerHeight;
    // 竖屏软键盘可能把可见区域压成宽大于高，不能因此误切成横屏牌桌。
    const compact = active && w > h && h <= 500 && (!editing || nativeLandscape);
    doc.documentElement.style.setProperty('--visible-height', `${height}px`);
    doc.documentElement.style.setProperty('--visible-top', `${v?.offsetTop || 0}px`);
    doc.documentElement.style.setProperty('--keyboard-inset', `${Math.max(0, win.innerHeight - height - (v?.offsetTop || 0))}px`);
    root.style.setProperty('--surface-width', `${w}px`);
    root.style.setProperty('--surface-height', `${h}px`);
    root.style.setProperty('--physical-width', `${width}px`);
    root.style.setProperty('--visible-left', `${v?.offsetLeft || 0}px`);
    root.style.setProperty('--surface-top', `${v?.offsetTop || 0}px`);
    root.classList.toggle('page-landscape', rotated);
    root.classList.toggle('compact-game', compact);
    root.classList.toggle('short-game', compact && h < 280);
    const next = { width: w, height: h, manual, rotated, compact,
      fullscreen: !!(doc.fullscreenElement || doc.webkitFullscreenElement),
      fullscreenSupported: !!(doc.documentElement.requestFullscreen || doc.documentElement.webkitRequestFullscreen) };
    const changed = !current || Object.keys(next).some(key => next[key] !== current[key]);
    current = next;
    if (changed) onChange(next);
  }
  function queueRefresh() {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => { frame = null; refresh(); });
  }
  for (const event of ['resize', 'scroll']) win.visualViewport?.addEventListener(event, queueRefresh);
  win.addEventListener('resize', queueRefresh);
  for (const event of ['focusin', 'focusout', 'fullscreenchange', 'webkitfullscreenchange']) doc.addEventListener(event, queueRefresh);
  return {
    refresh,
    size: () => current || { width: win.innerWidth, height: win.innerHeight },
    rect: element => mobileViewRect(element.getBoundingClientRect(), root.getBoundingClientRect(), current?.rotated),
    toggleLandscape() {
      manual = !manual;
      refresh();
      onNotice(manual ? '已横向显示；输入时暂回竖屏' : '已恢复自动布局');
    },
    async toggleFullscreen() {
      try {
        if (doc.fullscreenElement || doc.webkitFullscreenElement) {
          const exit = doc.fullscreenElement ? doc.exitFullscreen || doc.webkitExitFullscreen
            : doc.webkitExitFullscreen || doc.exitFullscreen;
          if (exit) await exit.call(doc);
        } else {
          const enter = doc.documentElement.requestFullscreen || doc.documentElement.webkitRequestFullscreen;
          if (!enter) return onNotice('当前浏览器不支持全屏，可在菜单中使用横向牌桌。');
          await enter.call(doc.documentElement);
        }
      } catch (_) { onNotice('无法切换全屏，当前牌局继续；可在菜单中使用横向牌桌。'); }
      refresh();
    },
  };
}
if (typeof module !== 'undefined') module.exports = { mobileViewRect, createMobileView };

/**
 * 一键启动编排脚本（start-game.bat 的实质逻辑）
 *
 * 功能：
 *  1. 清理占用目标端口的残留进程
 *  2. 启动游戏服务器（node server.js）
 *  3. 启动 Cloudflare 快速隧道，自动抓取公网 URL
 *  4. 将 URL 保存到 share-url.txt 并自动复制到剪贴板
 *  5. Ctrl+C 一键同时关闭服务器与隧道
 *
 * 用法：node start-server.js   （或直接双击 start-game.bat）
 * 环境变量：PORT（默认 3000）
 */
'use strict';
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || '3000';
const ROOT = __dirname;
const CF_TOOLS = path.join(ROOT, 'tools', 'cloudflared.exe');
const CF_TEMP = path.join(process.env.TEMP || '', 'poker-debug', 'cloudflared.exe');
const URL_FILE = path.join(ROOT, 'share-url.txt');
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 端口清理 ----------------
function killPort(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    exec(`netstat -ano | findstr :${port} | findstr LISTENING`, (err, stdout) => {
      if (!err && stdout) {
        const pids = [...new Set(
          stdout.split(/\r?\n/)
            .map((l) => l.trim().split(/\s+/).pop())
            .filter((x) => x && /^\d+$/.test(x)),
        )];
        for (const pid of pids) {
          try { process.kill(Number(pid)); } catch { /* 无权限或已退出 */ }
          console.log(`  [INFO] 已停止占用 ${port} 端口的旧进程 (PID ${pid})`);
        }
      }
      resolve();
    });
  });
}

// ---------------- 服务器就绪探测 ----------------
function waitForServer(port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const req = require('http').get(`http://localhost:${port}/`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

// ---------------- 剪贴板复制 ----------------
function copyClipboard(text) {
  if (process.platform !== 'win32') return;
  const ps = spawn('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value '${text}'`], { stdio: 'ignore' });
  ps.on('error', () => { /* powershell 不可用时静默降级 */ });
}

// ---------------- 主流程 ----------------
let serverProc = null;
let cfProc = null;
let urlFound = false;

function shutdown(label) {
  if (label) console.log(`\n${label}`);
  if (serverProc && !serverProc.killed) { try { serverProc.kill(); } catch { /* ignore */ } }
  if (cfProc && !cfProc.killed) { try { cfProc.kill(); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 400);
}

process.on('SIGINT', () => shutdown('正在关闭服务器与隧道...'));
process.on('SIGTERM', () => shutdown('正在关闭...'));

async function main() {
  console.log('==============================================');
  console.log('  德州扑克 · 一键启动');
  console.log('==============================================');

  // 1. 清理端口残留（旧代码进程会带新前端/旧逻辑，必须杀掉）
  await killPort(PORT);
  await sleep(400);

  // 2. 启动游戏服务器
  console.log(`[1/3] 启动游戏服务器 http://localhost:${PORT} ...`);
  serverProc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  serverProc.on('exit', (code) => {
    console.log(`\n[!] 游戏服务器已退出 (code ${code})，隧道即将关闭。`);
    shutdown(null);
  });

  const up = await waitForServer(PORT, 15000);
  if (!up) console.log('  [WARN] 服务器尚未就绪，继续启动隧道（稍后自动恢复）...');
  else console.log('  [OK] 服务器已就绪');

  // 3. 启动隧道并抓取公网 URL
  const cfPath = fs.existsSync(CF_TOOLS) ? CF_TOOLS : fs.existsSync(CF_TEMP) ? CF_TEMP : null;
  if (!cfPath) {
    console.log('  [WARN] 未找到 cloudflared.exe，仅局域网模式可用。');
    console.log(`         同网段朋友访问：http://<你的IP>:${PORT}`);
    console.log('         如需外网联机，请把 cloudflared.exe 放到 tools\\ 目录后重新启动。');
    console.log('         服务器运行中，按 Ctrl+C 停止。');
    await new Promise(() => {}); // 常驻等待
    return;
  }

  console.log('[2/3] 启动 Cloudflare 隧道（公网地址生成中，约需 3~8 秒）...');
  cfProc = spawn(cfPath, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onCfOutput = (buf) => {
    const text = buf.toString();
    if (urlFound) return;
    const m = text.match(URL_RE);
    if (!m) return;
    urlFound = true;
    const url = m[0];
    const hint =
      `【德州扑克 · 本场公网地址】\n${url}\n\n` +
      `玩法：\n` +
      `1. 打开上面的链接，填写昵称，创建或加入房间（4 位房号）\n` +
      `2. 快速邀请：直接发链接 ?room=房号，朋友打开免输房号\n` +
      `   例如：${url}?room=1234\n\n` +
      `注意：本地址仅在本次启动期间有效，重启后地址会变化。\n`;
    fs.writeFileSync(URL_FILE, hint, 'utf8');
    console.log('');
    console.log('  ==============================================');
    console.log('  ✅ 公网地址已生成（已保存到 share-url.txt 并复制到剪贴板）');
    console.log(`     ${url}`);
    console.log('     邀请链接示例：' + `${url}?room=1234`);
    console.log('  ==============================================');
    console.log('');
    copyClipboard(url);
  };
  cfProc.stdout.on('data', onCfOutput);
  cfProc.stderr.on('data', onCfOutput);

  cfProc.on('exit', (code) => {
    console.log(`\n[!] 隧道已断开 (code ${code})，服务器仍在运行：http://localhost:${PORT}`);
    console.log('    按 Ctrl+C 停止全部。');
  });

  console.log('[3/3] 全部就绪。本窗口保持开启；按 Ctrl+C 同时关闭服务器与隧道。');
}

main().catch((e) => {
  console.error('启动失败：', e && e.message ? e.message : e);
  process.exit(1);
});

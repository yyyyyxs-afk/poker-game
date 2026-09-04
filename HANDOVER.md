# 项目交接单 — 多人在线德州扑克

> 接收人：zcode  
> 交接日期：2026-08-27  
> 交付人：WorkBuddy（GDHC 用户）

---

## 一、项目概况

| 项 | 内容 |
|---|---|
| 名称 | poker-game |
| 类型 | 多人在线无限注德州扑克（No-Limit Texas Hold'em） |
| 技术栈 | Node.js + Express 5 + Socket.IO 4 |
| 源码位置 | `C:\Users\GDHC\WorkBuddy\2026-08-26-09-40-17\poker-game` |
| OneDrive 副本 | `C:\Users\GDHC\OneDrive\WorkBuddy\poker-game`（不含 node_modules / tools） |
| 依赖数 | 3 个（express, socket.io, socket.io-client） |
| Node 版本要求 | ≥ 18（实测 22.22.2） |
| 当前状态 | **可用** — 冒烟测试全绿，已实战联机验证 |

### 核心架构

```
浏览器（client.js 渲染 + 输入）
    ↕ Socket.IO WebSocket
服务端（server.js 权威逻辑：牌局状态机 + 牌力评估 + 边池分配）
```

**设计原则**：服务端是唯一权威，客户端只渲染和提交操作，天然防作弊。状态由服务端推送给所有玩家（`broadcast` → `sanitizeState` 个性化视图，只发自己的底牌）。

---

## 二、文件结构

```
poker-game/
├── server.js              # 服务端（~965行）：房间管理、牌局状态机、牌力评估、边池、Socket handlers
├── public/
│   ├── index.html         # 页面骨架（大厅 + 牌桌 + 弹窗 + 设置面板）
│   ├── client.js          # 客户端（~722行）：Socket 通信、座位渲染、操作面板、结算面板、音效、表情
│   └── style.css          # 浅紫柔和风样式（响应式，手机适配）
├── test/
│   └── smoke.test.js      # 冒烟测试（单元 + 3 客户端集成对局）
├── tools/
│   └── cloudflared.exe    # Cloudflare 隧道二进制（54MB，用于外网联机）
├── start-game.bat         # 一键启动：起 node 服务器 + cloudflared 隧道
├── package.json           # start / test 脚本
├── package-lock.json
├── README.md              # 简要说明文档
└── HANDOVER.md            # 本文件
```

---

## 三、完整功能清单

### 核心牌局
- [x] 完整流程：发牌 → 翻牌前 → 翻牌 → 转牌 → 河牌 → 摊牌
- [x] 无限注规则：跟注 / 加注（含最小加注校验）/ 全押 / 过牌 / 弃牌
- [x] 边池（Side Pot）自动分层分配，支持多人全押的复杂场景
- [x] 7 选 5 最优牌力评估（含 A-5 轮子顺子）
- [x] 摊牌高亮赢家最优 5 张牌（`evaluate7` 返回 `best5`）
- [x] 行动超时 45 秒自动过牌/弃牌
- [x] 摊牌后 20 秒自动开下一局（可手动跳过）

### 房间管理
- [x] 6 位字母数字邀请码（排除 0/O/1/I/L），crypto 随机生成 + 碰撞重试 + 加入限频
- [x] 2–6 人同桌
- [x] 房管设置（仅房主 + 仅等待阶段）：起始筹码 / 小盲 / 大盲
- [x] 房主离开自动转移给首位剩余玩家
- [x] 踢人功能（仅房主，`kick_player` 事件）
- [x] 邀请链接（`?room=XXXXXX` URL 参数预填邀请码，不区分大小写）

### 玩家体验
- [x] 断线重连（同名 + token 匹配自动恢复座位）
- [x] 掉线自动弃牌保护
- [x] 重买（筹码输光后补充，`rebuy` 事件）
- [x] 暂离/坐回（`sit_out` / `sit_back`，保留座位筹码不参与下局）
- [x] 积分输完不卡住（零筹码玩家保留座位，等待重买或手动开局）
- [x] 弃牌两段确认防误触（第一次点击进入确认态，2.5 秒内再点才执行）
- [x] 表情快捷互动（8 个白名单表情，1 秒限频）
- [x] 音效系统（Web Audio 合成，发牌/下注/轮到你/胜利，可开关）
- [x] 振动反馈（轮到自己时 `navigator.vibrate`）
- [x] 记住昵称 + 分房间 token（localStorage）
- [x] 本局总投入显示
- [x] 公共牌增量渲染动画
- [x] 底池变化动画 + 加注 toast 提示
- [x] 断线全屏提示遮罩

### UI
- [x] 浅紫柔和风（薰衣草底色 + 白色圆角面板 + 柔和紫阴影）
- [x] 彩色胶囊操作按钮（弃牌粉 / 过牌橙 / 跟注蓝 / 加注紫 / 全押粉红）
- [x] 响应式（手机竖屏 + 横屏适配）
- [x] 座位围绕椭圆分布（自己固定在底部，相对序号计算角度）
- [x] 结算面板（20 秒倒计时，清晰展示赢家牌型 + 5 张高亮最优牌）

### 联机
- [x] Cloudflare 快速隧道（`cloudflared.exe tunnel --url http://localhost:3000`）
- [x] 免注册，每次生成随机 trycloudflare.com 域名

---

## 四、关键设计约束（务必遵守）

### 1. 座位数组下标稳定性（最重要）

**玩家离开只能打 `left` 标记，不能置 `null`。**

座位数组 `room.players` 的下标被以下所有地方引用：
- `turnSeat`（当前行动座位号）
- `youSeat`（客户端自己的座位号）
- `dealerSeat`（庄家位）
- `room.queue`（行动队列，存的是座位号）
- 客户端 `renderSeats` 按下标渲染座位
- `sanitizeState` 遍历 `room.players` 生成状态

如果把某个位置设为 `null`，上述所有引用都会因读 null 的属性而崩溃。正确的做法是 `p.left = true; p.connected = false`，在下一局 `startHand` 开始时统一用 `filter(p => p && !p.left)` 清场。

### 2. `sanitizeState` 个性化视图

每个玩家收到的状态不同：只有自己的底牌（`hole`）是明牌，对手的 `hole` 为 `null`。摊牌后（`room.revealed = true`）所有未弃牌玩家的手牌公开。

### 3. `canAct` 判断

```js
function canAct(p) {
  return p && !p.folded && !p.allIn && p.connected && p.chips > 0 && p.inHand && !p.sittingOut;
}
```

这个函数决定了谁能行动，修改时需同时考虑：
- `sittingOut` 玩家不能行动（暂离）
- 零筹码玩家不能行动（但保留座位）
- 断线玩家不能行动

### 4. `playable` 过滤

`startHand` 用 `playable = connected && chips > 0 && !sittingOut` 过滤可参与本局的玩家。盲注位计算、庄家位轮转都跳过非 playable 玩家。

### 5. 筹码守恒（2026-08-27 起改为权威字段口径）

所有筹码在 `players[].chips` + `players[].totalBet` + `room.pot` 之间流转。房间维护权威字段 **`room.economyTotal`**（随 state 推送为 `economyTotal`）：玩家入座/重买时增加，离开座位被清退时扣除；房主在开局前改设置时按新起始筹码重置基准。对局中任意时刻必须满足：

```
Σ(players.chips + players.totalBet) === room.economyTotal
```

冒烟测试按此断言（天然兼容重买注入与离场清退）。**修改任何资金路径（pay、rebuy、kick_player、handleLeave、update_settings）必须同步维护该字段**——头部清退与 startHand 清场两处 pop 循环都已接入扣账。

### 6. `scheduleNextHandIfReady`

局间自动开局调度器。关键逻辑：
- 有 ≥ 2 名 playable 玩家 → 排 20 秒定时器自动开局
- 有在线零筹码玩家但不凑齐 → 不排定时器，等待重买
- 实在没人能玩 → 设 `gameOver`，整场结束

**修改 `endHand`、`rebuy`、`handleLeave`、`kick_player` 后都要调用 `scheduleNextHandIfReady` 重新检查。**

### 7. 静态资源缓存

`express.static` 配置了 `Cache-Control: no-cache`（保留 etag 协商缓存）。这是为了避免浏览器缓存新 client.js + 旧 index.html 的混搭导致渲染崩溃。修改前端文件后用户普通刷新即可拿到最新版。

---

## 五、Socket 事件清单

### 客户端 → 服务端

| 事件 | 参数 | 回调 | 说明 |
|---|---|---|---|
| `create_room` | `{ name }` | `{ ok, code, token }` | 创建房间 |
| `join_room` | `{ code, name, token }` | `{ ok, code, token, err }` | 加入房间（含断线重连） |
| `start_game` | `null` | `{ ok, err }` | 开局（仅 waiting/handover 阶段） |
| `next_hand` | `null` | `{ ok, err }` | 立即开下一局（跳过倒计时） |
| `action` | `{ type, amount }` | `{ ok, err }` | 行动：fold/check/call/raise/allin |
| `rebuy` | `null` | `{ ok, err }` | 重买筹码（仅 chips=0 且 waiting/handover） |
| `update_settings` | `{ startChips, smallBlind, bigBlind }` | `{ ok, settings, err }` | 房主修改设置 |
| `sit_out` | `null` | `{ ok, err }` | 暂离 |
| `sit_back` | `null` | `{ ok, err }` | 坐回 |
| `kick_player` | `{ seat }` | `{ ok, err }` | 踢人（仅房主） |
| `emoji` | `{ emoji }` | `{ ok, err }` | 表情（8 白名单，1 秒限频） |
| `leave_room` | — | — | 主动离开 |

### 服务端 → 客户端

| 事件 | 数据 | 说明 |
|---|---|---|
| `state` | `sanitizeState()` 返回值 | 全量状态推送（每次变化都推） |
| `emoji` | `{ seat, emoji }` | 表情广播 |
| `kicked` | `{ reason }` | 被踢出通知 |

### `state` 数据结构（`sanitizeState` 返回）

```js
{
  code, stage, handNumber,           // 房间信息
  smallBlind, bigBlind, startChips,  // 盲注/筹码（兼容旧客户端的顶层字段）
  settings: { startChips, smallBlind, bigBlind },
  isHost, hostName,                  // 房主标识
  dealerSeat, turnSeat, youSeat,     // 座位索引
  community: [{ r, s }],             // 公共牌
  pot, currentBet, minRaise,         // 底池/下注
  gameOver, economyTotal, results, revealed,       // 结算（economyTotal：筹码守恒权威基准）
  logs: [],                           // 最近 12 条日志
  players: [{
    seat, name, avatar, chips,
    roundBet, totalBet,               // 下注
    folded, allIn, connected, inHand, sittingOut,  // 状态
    isDealer,                         // 是否庄家
    hole: [{ r, s }] | null,          // 底牌（仅自己或摊牌后可见）
    holeCount,                        // 手牌数量（对手也可见）
  }],
}
```

---

## 六、运行方式

### 安装

```bash
cd poker-game
npm install --registry=https://registry.npmmirror.com
```

### 启动服务器

```bash
# 默认端口 3000
npm start

# 指定端口
PORT=8080 npm start
```

浏览器打开 `http://localhost:3000`。

### 外网联机（Cloudflare 隧道）

```bash
# 方法一：一键启动
start-game.bat

# 方法二：手动
# 终端 1
npm start
# 终端 2
tools\cloudflared.exe tunnel --url http://localhost:3000 --no-autoupdate
```

每次重启生成随机 trycloudflare.com 域名。免注册，入口在香港节点，国内访问友好。

### 运行测试

```bash
# 终端 1：启动服务器
PORT=3000 npm start

# 终端 2：运行冒烟测试
npm test
# 或指定地址
TEST_URL=http://localhost:3000 npm test
```

> **注意**：冒烟测试会在同一服务器上创建房间，不要和真实玩家在同一实例上同时跑测试，会互相干扰。

---

## 七、踩过的坑（经验教训）

### 1. `const n` 使用先于定义（已修复）
`startHand` 中盲注位计算 `if (n === 2)` 在使用 `n` 时它还没声明，导致 `ReferenceError`，服务器开局即崩。已将 `const n = room.players.length` 移到盲注位判断之前。

### 2. 座位叠在牌桌中央（已修复）
`seatPosition(index)` 收到的 `index` 已是相对序号（`relIdx`），但函数内部又减了一次 `mySeat` → 非 0 号座位玩家看到的布局全错。修复：直接用 `index` 算角度，删除 offset 行。

**教训**：「房主自测正常、别人玩就坏」的典型模式 = 代码里隐含假设自己座位号为 0。布局类 bug 用真实浏览器截图验收。

### 3. 弃牌按钮"没用"（已修复）
长按 600ms 方案下，普通单击不足 600ms 被 `pointerup` 当作取消，点击无任何反馈。改为两段点击确认。

**教训**：防误触交互别用长按做唯一路径，两段点击在移动端更可靠。

### 4. 缓存混搭导致空屏（已修复）
浏览器缓存了新版 client.js + 旧版 index.html，`renderTableInfo` 访问 `state.settings` 时抛异常，`render()` 中断导致座位全消失。修复：`express.static` 加 `Cache-Control: no-cache`。

**教训**：改前端结构（新增 DOM id）时必须同时考虑缓存混搭问题。

### 5. 玩家重复入房（已修复）
刷新页面时新连接先到、旧连接未断，同名重连匹配要求 `!connected` 落空 → `push` 重复座位。修复：同名即接管原座位（不要求离线），旧 socket 后续 disconnect 自然失效。

### 6. Git Bash 的 `taskkill //PID` 无效
Git Bash 下杀进程需用 PowerShell `Stop-Process`，否则端口残留导致新服务器起不来。

### 7. 测试脚本中的模板字符串
Git Bash 的 heredoc 内 `${}` 模板字符串会被 bash 报 `Bad substitution`，测试脚本避免用模板字符串，用字符串拼接。

---

## 八、已知边界 & 未做事项

### 已知边界
- 房间数据在内存中，进程重启即清空（无持久化）
- 未做用户鉴权，同名 + token 即视为同一玩家（便于重连，但有冒名风险）
- 未做观战模式
- 未做聊天功能
- 未做房间 TTL 回收（空房间在最后一人离开时自动销毁）
- `cloudflared.exe` 在 OneDrive 副本中不存在（54MB 二进制不同步）

### 下轮候选功能（按优先级）
1. 观战模式
2. 房间持久化（服务重启后恢复房间）
3. Socket.IO room 广播优化（目前是遍历玩家逐个 emit）

### 2026-09-04 最近完成
- 锁房、可配置行动/局间时长与重买开关
- 新手 2 分钟玩法说明与牌型速查
- 完整单局复盘：筹码变化、底池/边池、摊牌最佳五张、逐街行动时间线
- 最近一局复盘跨局保留，下一手开始后仍可主动回看
- 好友文字聊天：最近 50 条、未读提醒、80 字限制与短时刷屏保护

---

## 九、技术债

| 项 | 说明 | 影响 |
|---|---|---|
| `nextTip` 变量在赋值前被引用 | `renderResults` 中 `nextTip.textContent` 在 `let nextTip` 声明行之前使用（第 655 行 vs 662 行） | 目前因 JS 变量提升未报错，但严格模式或有隐患 |
| `countdown` 初始值 8 vs 实际 20 | `let countdown = 8` 但实际倒计时从 20 开始 | 仅在结算弹窗首次渲染且 `lastResultKey` 未变化时有 1 帧显示 8，随后立即被 setInterval 覆盖 |
| 冒烟测试并发干扰 | 多个测试/客户端在同一服务器上会共享房间 | 测试方法问题非功能缺陷，应在干净实例上跑 |
| `express 5.2.1` | Express 5 仍是较新版本，部分中间件 API 有变 | 目前无兼容问题 |

---

## 十、验收状态

| 验收项 | 状态 |
|---|---|
| 冒烟测试（单元 + 集成） | ✅ 全绿 |
| 2026-08-27 修复后连续 20 轮冒烟回归 | ✅ 全绿 |
| 3 客户端随机对局 2 局 + 筹码守恒 | ✅ 通过 |
| 积分输完不卡住 + 重买/下场 | ✅ 已实现 |
| 结算面板重做（20s 倒计时 + 牌型展示） | ✅ 已实现 |
| 踢人功能 | ✅ 已实现 |
| 暂离/坐回 | ✅ 已实现 |
| 手机端适配 | ✅ 已验证 |
| Cloudflare 外网联机 | ✅ 已验证 |
| OneDrive 同步 | ✅ 已同步 |

---

## 十一、2026-08-27 交接后修复记录（zcode 接手）

### 1. 🔴 筹码不守恒回归 bug（严重，已修复）

**现象**：有人输光后凑不齐 2 名可玩玩家时，`startHand`「人数不足」提前返回分支直接把 `stage` 改为 `waiting` 并广播，但**没有清掉上一局残留的 `totalBet`**——此时赢家筹码已发放，广播出去的状态同时含"新筹码 + 旧下注"，`Σ(chips+totalBet)` 超发一倍（测试实测 12000 != 6000）；真实玩家在等待界面会看到幽灵底池。

**修复**：该分支先完整清场（totalBet/roundBet/allIn/hole/盲注标记、pot/currentBet/community/results 归零、turnSeat=-1）再广播。

> 教训：冒烟测试原断言固定总额 6000，两天前未触发全押爆仓场景所以一直是绿的；接手首轮重跑即复现。**交付前测试轮次太少 + 场景覆盖不足会漏掉确定性 bug。**

### 2. rebuy 回执时序修正

原先"先广播后回执"，客户端先看到新筹码状态、后拿到到账确认。改为**先回执后广播**，保证订阅端"筹码变化"与"到账通知"严格有序。

### 3. 新增权威字段 `economyTotal`

守恒基准从"客户端各自推算固定总额"升级为服务端权威记账：入座/重买 `+=`，离座清退 `-=`（startHand 清场与两处尾部 pop 循环均接入），房主改设置时重置基准。state 推送随行下发，供任何端做一致性校验。

### 4. 冒烟测试健壮性改造

- 行动驱动器改用最新状态复核，消除 30ms 延迟窗口内对手先行动导致的误判（"还没轮到你行动"视为正常抖动）
- 输光玩家自动重买 → 房主重新开局，把**重买链路纳入自动化覆盖**
- 守恒断言切换到服务端 `economyTotal`
- 违规时输出完整状态快照，便于定位

**回归验证：连跑 20 轮冒烟全绿**（含多次爆仓→重买→续局场景）。

---

## 十二、2026-08-28 稳定性升级记录（M1–M3）

> 目标口径：从「功能完整」升级为「朋友长期真实游玩稳定可靠」。稳定性 > 公平性 > 网络容错 > 操作体验 > 新功能。

### M1（P0，已完成）

1. **洗牌随机性**：`newDeck` 改用 `crypto.randomInt` + Fisher-Yates（原 `Math.random`）；新增测试：52 张唯一、合法牌集、20 次洗牌顺序不重复
2. **邀请码安全**：4 位数字 → **6 位字母数字**（字符集排除 0/O/1/I/L，crypto 随机 + 碰撞重试）；输入不区分大小写；`?room=XXXXXX` 直达不变；**不兼容旧 4 位房号**（旧房间内存态，重启自然淘汰）。加入限频：同一 socket 60 秒内 ≥15 次命中不存在房间即拒绝（防 AAAAAA→AAAAAB 扫房）
3. **断线保护窗口（8 秒）**：对局中断线不再瞬间弃牌——行动者断线保留行动权 8 秒，窗口过后自动过牌/弃牌；重连恢复**断线前剩余行动时间**（不重新计满，防断线续命）；主动退出仍立即弃牌。为支持该机制，`applyAction` 新增 `auto` 通道（服务端自动动作可作用于离线玩家）并给行动定时器记录绝对截止时间 `turnDeadline`
4. **回归测试体系**：新增 `test/rules.test.js`（13 项纯单元：洗牌/牌力/轮子/best5/平分/边池阶梯）；`smoke.test.js` 重写为 2/3/6 人集成 + 对局中退出 + 保护窗口两场景 + 新设置项校验，全程校验筹码守恒与战绩零和

### M2（已完成）

5. **快捷下注**：加注面板预设扩为 1/3池、1/2池、2/3池、满池，基于服务端权威 pot/currentBet 计算，自动钳制到 [最小加注, 最大可加]
6. **房间设置扩充**：行动时长（20/30/45/60 秒）、局间倒计时（5/10/20 秒）、允许重买（开/关）；仅等待阶段可改，服务端白名单校验

### M3（已完成）

7. **本场 Session 战绩**：按玩家记录买入（含重买累加）、参与手数、胜场；离场玩家盈亏入档；`state.session` 随状态下发；结算面板渲染战绩表；**全场盈亏之和恒为 0**（测试逐状态校验）

### 本轮发现并修复的潜伏 Bug

- **经济清退误扣**：`startHand` 清场与尾部清退对 left 玩家扣 `chips + totalBet`，但残留 `totalBet` 在本手结算时已并入赢家筹码，导致 `economyTotal` 少计 → 修正为按阶段区分（对局中弹出扣 `chips+totalBet`，局间清退只扣 `chips`）
- **对局中被踢玩家可参与摊牌分池**：踢人不折叠 → 空手玩家可能被 `computePots` 判为 eligible → 现对局中被踢立即标记弃牌并推进行动队列
- **断线自动弃牌被 canAct 拒绝**：定时器触发的自动动作走 `applyAction` 的 `canAct`（要求 connected），断线玩家永远被拒 → 新增 `auto` 通道修复（这是保护窗口能落地的前提）
- **preGrace 跨手残留**：断线恢复记录未在新手清除，可能错误恢复过期截止时间 → `startHand` 统一清空

### 验收

- 自动测试：规则 13 项 + 冒烟 7 场景，**连跑 3 轮全绿**；`economyTotal` 与战绩零和逐状态校验
- 浏览器实测：6 位邀请码建房（JC9EF5）、房管设置三新字段保存/回显、快捷下注四预设、结算面板战绩表（实测 -2000/+4000/-2000 零和）
- 手机宽度 320/375/430：横向滚动为零（修复了 320 宽度座位溢出 8px：座位 110px + 窄屏横向钳制 83%）

### 未做（下一阶段候选）

- Room Snapshot 断电恢复（设计评估后判定当前内存架构可做但需谨慎，建议独立一轮）
- 「澳门豪华风」前端全面重做（方案 E 已定稿，效果图在 `public/mockups/`）

---

> 如有疑问可查阅 `.workbuddy/memory/2026-08-26.md`，里面有完整的开发历程和每个 Bug 的修复记录。

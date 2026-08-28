# Koyeb 免费云部署指南（不需要信用卡）

> 适合：没有 Visa/Mastercard 国际卡、被 Render 绑卡步骤卡住的情况。
> Koyeb 免费档**无需信用卡**，支持 WebSocket，部署后得到固定网址
> `https://<应用名>-<组织名>.koyeb.app`（全国通用，电脑关机也能玩）。
> 免费额度细则以官网为准；若免费实例有闲置休眠，行为与 Render 类似（约几十秒唤醒）。

## 部署步骤（约 5 分钟，只需一次）

1. 打开 [https://app.koyeb.com](https://app.koyeb.com) → **Sign up with GitHub**（用你已登录的 GitHub 账号 `yyyyyxs-afk` 授权）
2. 授权时允许 Koyeb 访问 `poker-game` 仓库（私有仓库需在 GitHub 授权页选中它）
3. 控制台点 **Create App**（或 +）→ 选 **GitHub** 仓库 → 选中 `poker-game`
4. 构建配置：
   - **Builder**：选 **Buildpack**（会自动识别 Node.js）
   - **Run command**：`npm start`（一般已自动填好；若空则手动填）
   - **Ports**：保持默认 HTTP 80 即可（我们的服务会读环境变量 PORT；如需手动，Port=3000，对外 80）
   - **Instance**：选 **Free** 档
5. 点 **Deploy**，等 1-2 分钟构建完成
6. 页面给出固定网址（形如 `https://poker-game-xxxx.koyeb.app`）→ 发给朋友，收藏即永久使用

## 部署后自检

- 打开网址能看到大厅页（深红牌桌 + 金色「MACAU STYLE」）
- 建房后用手机流量（关 WiFi）打开同一网址加入房间，能正常出牌即通

## 常见问题

| 现象 | 处理 |
|---|---|
| 构建失败 | 看构建日志；多为 Node 版本或依赖问题，截图发我 |
| 打开页面 502 / Service paused | 免费实例休眠中，刷新等待约 1 分钟唤醒 |
| 想换回 Render | 仓库里已有 `render.yaml`，两边配置互不影响，随时可换 |

## 与 Render 的关系

两个平台配置文件都已在仓库里（`render.yaml` + 本指南），**任选其一部署即可**，互不冲突。
哪个先用起来了，另一个就当作备份方案。

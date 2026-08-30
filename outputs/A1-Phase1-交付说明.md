# A1 UI 第二轮改版 · Phase 1 交付说明

## 结论

Phase 1 开发完成，等待独立验收。已建立 A1 设计基础与可交互 PC 组件检查页；未进入 Phase 2，未修改现有牌桌页面、客户端牌局渲染、Socket.IO 协议或服务端逻辑。

## 本阶段交付

- `public/a1-foundation.css`：颜色、字体、间距、圆角、边框、阴影及组件状态 tokens。
- `public/a1-phase1.html` / `public/a1-phase1.js`：按钮、面板、Seat、扑克牌、牌背、下注、加注控制器、图标与排版检查页。
- `public/assets/a1/avatars/`：3 个 128 × 128 透明 PNG 像素头像样稿。
- `public/assets/a1/card-back.png`：真实透明 PNG 牌背资产。
- `public/assets/a1/icons/`：Bootstrap Icons v1.11.3 官方 SVG 与来源说明。
- `design-qa.md`：本阶段视觉对照与浏览器验证结论。

## 预览

安装依赖并启动服务器后打开：

```text
http://localhost:4173/a1-phase1.html
```

本次交付时本地预览保持运行。

## 验证

- `npm test`：通过；13 项规则测试及 2/3/6 人集成、离场守恒、断线重连、设置广播场景全部通过。
- 浏览器：1920 × 1080 与 1440 × 1000 检查页已打开并截图；图片缺失 0。
- 交互：操作按钮、快捷加注、加减步进、次级图标反馈均已验证。
- 控制台：warning/error 为 0。

## 证据

- `audit/phase1/a1-phase1-1920x1080.png`
- `audit/phase1/a1-phase1-1440x1000-viewport.png`
- `audit/phase1/a1-phase1-focused-comparison.png`

## 已知限制

- 检查页是设计基础样稿，不连接真实牌局状态。
- 完整 PC 牌桌、Hero/Action 一体化、日志布局及移动端均属于后续 Phase，当前没有实现。
- 头像样稿已统一生成规范；是否作为正式全量头像集仍需独立验收决定。

# A1 Phase 1 图像资产

## card-back.png

- 生成方式：OpenAI 内置 ImageGen。
- 用途：A1 扑克牌背面基础样稿。
- 规格：240 × 336 PNG，透明背景，浏览器中按组件尺寸缩放。
- 最终 Prompt：

```text
Use case: stylized-concept
Asset type: poker game card-back raster asset for a restrained modern friendship poker UI
Primary request: create one centered, face-down playing card back as a clean standalone asset
Scene/backdrop: genuinely transparent background outside the card silhouette
Subject: a single vertical poker card back, exact 5:7 proportion, gently rounded corners, dark desaturated blue-gray face, a very subtle inset border and one small centered muted geometric woven motif
Style/medium: crisp low-detail raster UI asset, premium but understated, visually compatible with a warm gray felt poker table and charcoal interface
Composition/framing: isolated full card, front-on orthographic view, symmetrical, no perspective, generous transparent margin, sharp edges
Color palette: charcoal #20282b, desaturated blue-gray #536772, muted warm gray #8f8b82
Constraints: no text, no letters, no numbers, no suits, no logo, no casino gold, no glow, no neon, no drop shadow, no background, no mockup scene, no hands, no chips, no other cards; actual transparency outside the rounded card silhouette
```

机械后处理仅包括透明边界裁切、缩放与 PNG 优化；原始生成文件仍保留在 Codex 生成目录。

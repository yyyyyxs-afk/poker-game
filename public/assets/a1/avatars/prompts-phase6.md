# Phase 6 头像扩充提示词（P2-3 · 第 4~6 款）

目标：把像素头像从 3 款扩到 6 款（6 席位一席一款）。以下 3 款沿用 Phase 1
`prompts.md` 的规范与格式，交总负责人用同一 ImageGen 流程生成后，放入本目录：

- `avatar-teal-ponytail.png`
- `avatar-amber-beanie.png`
- `avatar-violet-bangs.png`

生成要求（三款共同）：128×128 透明 PNG、真透明 alpha、硬像素边、无半透明
边缘像素、单人、无文字/水印/框/背景；低饱和、32bit 像素游戏头像语言，
2008–2012 QQ 空间/贴吧非主流审美；在 32~64px 下可辨认；与既有三款
（蓝发耳机 / 洋红不对称短发 / 红发反戴帽）发色与剪影明显区分。

生成完成后的代码接入（一行）：`public/client.js` 的 `AVATAR_PNGS` 数组
追加三项文件名即可（数组按座位号取模复用，6 项即一席一款）。

## avatar-teal-ponytail.png

```text
Use case: stylized-concept
Asset type: transparent pixel-art poker player avatar PNG for a dark online game UI
Primary request: create exactly one original head-and-shoulders pixel-art portrait of a cheerful young woman with dark muted teal hair in a high side ponytail and two small silver hair pins. Front-facing or slight three-quarter view, bright friendly expression with a small open smile, clear readable silhouette.
Style/medium: authentic circa 2008–2012 Chinese QQ Space / Tieba non-mainstream pixel avatar; 32-bit sprite-game portrait language; deliberately chunky square pixel clusters; crisp nearest-neighbor hard edges; restrained detail; nostalgic browser-game aesthetic.
Composition: centered square head-and-shoulders bust, large head, fully contained silhouette, transparent breathing room, strong readable outline, suitable for 128×128 use.
Scene/backdrop: genuinely transparent background, no frame, badge, circle, glow, shadow, haze, or checkerboard.
Palette: low-saturation dark teal, muted gray-green, off-white, soft beige skin, subtle charcoal outline; no bright neon.
Constraints: one character only; real transparent alpha; no semi-transparent pixels outside the silhouette; no text, watermark, UI, animals, NFT/PFP styling, cyberpunk neon, photorealism, smooth airbrush, modern detailed anime key art, glossy 3D, or background scenery.
```

## avatar-amber-beanie.png

```text
Use case: stylized-concept
Asset type: transparent pixel-art poker player avatar PNG for a dark online game UI
Primary request: create exactly one original head-and-shoulders pixel-art portrait of a laid-back young man with messy dark amber hair peeking out from a muted mustard-yellow knit beanie, small round glasses with dark frames. Front-facing or slight three-quarter view, relaxed half-lidded expression, clear readable silhouette.
Style/medium: authentic circa 2008–2012 Chinese QQ Space / Tieba non-mainstream pixel avatar; nostalgic 32-bit pixel portrait with chunky pixel clusters, strong dark outline, limited low-saturation palette, readable at 32–64 px.
Composition: centered square bust with transparent space around the beanie and shoulders.
Scene/backdrop: genuinely transparent background; no colored square, frame, halo, or shadow outside the character.
Palette: muted mustard yellow, dark amber brown, charcoal clothing, warm desaturated skin, very dark outlines; avoid bright neon.
Constraints: exactly one character; genuine transparent alpha; hard pixel edges, no feathering or halo; no text, letters, symbols, watermark, UI, poker cards, chips, or accessories obscuring the face.
Avoid: polished modern anime illustration, smooth painting, vector smoothness, photorealism, NFT gloss, cyberpunk neon, saturated orange, animals, masks.
```

## avatar-violet-bangs.png

```text
Use case: stylized-concept
Asset type: transparent pixel-art poker player avatar PNG for a dark online game UI
Primary request: create exactly one original head-and-shoulders pixel-art portrait of a quiet cool young person with straight dark violet hair and full blunt bangs covering the eyebrows, one side slightly longer, wearing a dark high-collar top. Front-facing, calm neutral expression with small pixel eyes, clear readable silhouette.
Style/medium: authentic circa 2008–2012 Chinese QQ Space / Tieba non-mainstream pixel avatar aesthetic; true low-resolution 32-bit pixel-game portrait language; deliberately chunky square pixels, crisp hard edges, limited low-saturation palette, modest one-pixel highlights and shadows. It must feel like a tiny retro social-game avatar, not polished modern illustration.
Composition/framing: centered square head-and-shoulders bust, face large in frame, a little breathing room around hair and shoulders, designed to remain legible at 32–48 px.
Scene/backdrop: genuinely transparent background all the way to the character silhouette; no colored square, card, frame, halo, shadow, or checkerboard.
Color palette: dark muted violet, cool plum gray, off-white highlights, soft beige skin, very dark brown outlines, charcoal top; avoid bright neon and saturated purple gradients.
Constraints: exactly one character; transparent alpha background; no antialiasing or soft edge blur; no text, letters, symbols, watermark, UI, poker cards, chips. Preserve a strong clean pixel silhouette.
Avoid: anime key art, glossy mobile-game portrait, high-detail painting, photorealism, animals, NFT/PFP styling, cyberpunk neon, bloom, emoji, vector icon, 3D render.
```

# UI polish review — 2026-09-23

Scope: visual and interaction polish in the isolated worktree, preserving poker rules, seat/chip positions, and the main checkout. Baseline: `9bb5659c8b3f59c92e8071d41b3d6848c8bf165d`.

## Baseline observations

- The 1366×768 lobby, waiting room, active table, desktop replay, and settings are legible and keep their main controls available.
- At 375×812 and 320×568, the fixed mobile log/chat sheet (z-index 65) draws above the replay and room settings overlays (z-index 50). It covers part of each dialog, including lower controls. The rules dialog already uses z-index 90 and is not affected.
- Mobile table views are compact and use a bottom-sheet chat/log panel. The log collapse control is operable. Table/seat geometry is out of scope for this polish pass.
- In live Socket.IO play, a six-player room was created and joined, robot and browser chat exchanged, the browser completed a raise action, and replay/settings/log toggles were exercised.

## Baseline artifacts

- `01` lobby at 1366×768
- `02` completed table at 1366×768
- `03` turn-expired table at 1366×768 (the action timer advanced while capturing, so this is not a raise-drawer image)
- `04`–`05` desktop replay, top and lower timeline
- `06`–`07` replay at 375×812 and 320×568
- `08`–`11` desktop and mobile settings, including a six-player waiting room
- `12` chat in a six-player waiting room
- `13` active six-player table at 1366×768
- `14` after a confirmed raise at 1366×768
- `15b`–`16` active table at 375×812 and 320×568

## Change and verification

Only one product rule changed in this pass: `public/style.css` gives `#settings-overlay` and `#result-overlay` z-index 90, above the mobile `#log-panel` bottom sheet at z-index 65. No poker logic, chip math, or seat/table coordinates changed.

### Browser and Socket.IO checks

- Desktop: 1366×768 room settings dialog opens with every field and both footer actions visible (`after-settings-1366x768.png`).
- Mobile: 375×812 settings remains fully visible above the expanded log sheet; the 375×812 replay modal also draws above the sheet (`after-settings-375x812.png`, `after-replay-375x812.png`).
- Small mobile: 320×568 settings can scroll internally to expose Cancel and Save while the log sheet stays behind it (`after-settings-320x568.png`, `after-settings-320x568-lower.png`). The replay modal is visually above the chat/log sheet at this size (`after-replay-320x568.png`).
- Fresh mobile load at 320×568 starts with the log sheet collapsed and the invite control visible. A six-player local Socket.IO room joined by room code. In a live hand, the browser raised to 40 and the stack reflected 1,960; robot and browser chat messages arrived across clients. The log collapse, replay, and settings controls were exercised; the invitation control was confirmed visible.
- At 320×568 the dialogs are taller than the viewport and require their own scroll area for the lowest content; the settings action row remains reachable. Existing mobile table geometry was left alone.

### Automated checks

- `npm test` — passed the full existing suite: UI content, rules, runtime, network guards, multiplayer/socket behavior, and geometry.
- Geometry reported exactly the existing four 320×568 crowding/ownership exceptions; all tested layouts stayed in bounds and had zero intersections.
- `git diff --check` — passed.

## Screenshot index

Before images: `01`–`16` (with `03` labeled as a turn-expired capture and `15` ignored in favor of the correctly sized `15b`). After images: settings at 1366×768, 375×812, and 320×568 (top and lower scroll); replay at 375×812 and 320×568; plus supplementary waiting-room/invite and table-log captures. All are in this directory.

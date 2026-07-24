const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// The issue in visibleWidth is that `Bun.stringWidth` counts the payload in ST-terminated OSC 8 links
// but it is counting some characters of `\x1b\\` or `\x07` or `\x1b]8;;` ?
// Wait, `\x1b]8;;url\x07` is skipped by stringWidth, but `\x1b]8;;url\x1b\\` has length 2 because it strips `\x1b]...` but maybe not the ST?
// Let's strip OSC 8 globally before visibleWidth logic!
// But wait, the PR specifically normalized OSC 8 terminators to BEL BEFORE lexing to solve this!
// If we just strip it in visibleWidth, we avoid the issue without modifying the Markdown text?
// But Marked has already lexed it wrong.
// So Marked interprets `\x1b\\` as backslash + something, causing issues.
// But we ALREADY normalized it in Markdown!
// Why did visibleWidth return 90 for the table row?

// Ah! In `visibleWidth`, if there are no escape sequences (which `str.includes(ESC)` checks), it uses fast path.
// BUT we replaced `ESC \\` with `BEL` (\x07).
// So `str` contains `\x07` and NO ESC!
// So it takes the fast path!
// And in the fast path:
// `if (str.length >= LONG_WIDTH_FAST_PATH_MIN && !str.includes(ESC))`
// `str` does NOT include ESC anymore! Because we replaced `\x1b]8;...` ? No, `\x1b]8;` still has ESC.

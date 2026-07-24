const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// The issue with OSC 66 text-sizing headings might be that `strippedStr` is what we pass to `Bun.stringWidth`,
// but later `utils.ts` adds back the width of OSC 66.
// Wait, `strippedStr` replaces OSC 8. Does it affect OSC 66?
// OSC 8 is `\x1b]8;`. OSC 66 is `\x1b]66;`. They are different!
// Let's check `visibleWidth` implementation of OSC 66.

console.log(code.match(/OSC66_SPAN_REGEX\.lastIndex = 0;/g));
// ...

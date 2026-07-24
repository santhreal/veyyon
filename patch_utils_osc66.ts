const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// I need to change `let width = Bun.stringWidth(strippedStr, STRING_WIDTH_OPTS);`
// to avoid counting OSC 66.
// Wait! `str` has OSC 66. `strippedStr` is `str.replace` OSC 8.
// `Bun.stringWidth` in bun ignores CSI/OSC but maybe it does NOT ignore OSC 66?
// Actually OSC 66 is `\x1b]66;...`. `Bun.stringWidth` should ignore it.
// Why did the tests fail after I replaced `str` with `strippedStr`?
// Oh! Because `Bun.stringWidth` was failing when I used my script that replaced the WHOLE file.
// But now I'm only modifying the specific `Bun.stringWidth` calls!
// Wait, my replacement was:
// `let strippedStr = str; if (strippedStr.includes('\\x1b]8;')) { ... }`

console.log(code.includes("strippedStr"));

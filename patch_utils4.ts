const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// If `Bun.stringWidth` in newer Bun versions evaluates OSC 66 to 18!
// wait, `\x1b]66;s=2:v=0;Hello\x1b\\` has length 22.
// Wait, `Hello` is 5. If `Bun.stringWidth` evaluates to 18, it means it is NOT stripping `\x1b]66;...`.
// It only strips SOME escapes.
// Ah! This is why `Bun.stringWidth` was broken!

// To fix `visibleWidth` properly, we should strip ALL OSC strings before `Bun.stringWidth` if `Bun.stringWidth` fails to do so.
// Or we can just strip OSC 8 and OSC 66!
const replaceBlock = `
	let strippedStr = str;
	if (strippedStr.includes('\\x1b]')) {
		strippedStr = strippedStr.replace(/\\x1b\\][0-9]+;[^\x07\x1b]*(?:\x07|\\x1b\\\\)/g, "");
	}
	let width = Bun.stringWidth(strippedStr, STRING_WIDTH_OPTS);
`;

code = code.replace(/let width = Bun\.stringWidth\(str, STRING_WIDTH_OPTS\);/g, replaceBlock);

fs.writeFileSync('packages/tui/src/utils.ts', code);

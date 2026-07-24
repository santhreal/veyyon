const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// OSC 8 must be stripped entirely, since Bun.stringWidth in bun 1.2+ doesn't drop the payload string inside the OSC 8 definition.
// Wait, an OSC 8 is \x1b]8;;url\x07. `url` is 3 characters. `hello` is 5.
// Ah! `\x1b]8;;` (7 chars) + `url` (3 chars) + `\x07` (1) + `hello` (5).
// In test_visible_width_manual2: `\x1b]8;;url\x07hello\x1b]8;;\x07` gave 16.
// `hello` is 5. 16 - 5 = 11.
// It didn't drop `url`. It counts `url`! It counts `;;`!
// In older bun versions it probably stripped it all, but now it doesn't?
// Actually, earlier we saw `Bun.stringWidth` in utils.ts relies on it:
// "// `Bun.stringWidth` is a JSC builtin... It strips CSI/OSC to zero cells..."
// But apparently it DOES NOT strip OSC 8 correctly!

const replaceBlock = `
	let strippedStr = str;
	// Bun.stringWidth does not fully strip OSC 8 sequences (it leaves URLs and semi-colons visible).
	if (strippedStr.includes('\\x1b]8;')) {
		strippedStr = strippedStr.replace(/\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g, "");
	}
	let width = Bun.stringWidth(strippedStr, STRING_WIDTH_OPTS);
`;

code = code.replace(/let width = Bun\.stringWidth\(str, STRING_WIDTH_OPTS\);/g, replaceBlock);

fs.writeFileSync('packages/tui/src/utils.ts', code);

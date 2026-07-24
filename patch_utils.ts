const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// Also replace the fallback Bun.stringWidth

const fastPathReplace = `
		let strippedStr = str.replace(/\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g, "");
		let width = Bun.stringWidth(strippedStr, STRING_WIDTH_OPTS);
`;

code = code.replace(
	/let width = Bun\.stringWidth\(str, STRING_WIDTH_OPTS\);/g,
	fastPathReplace
);

fs.writeFileSync('packages/tui/src/utils.ts', code);

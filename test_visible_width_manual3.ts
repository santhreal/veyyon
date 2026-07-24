console.log(Bun.stringWidth("\x1b]8;;url\x1b\\hello", { countAnsiEscapeCodes: false }));
console.log(Bun.stringWidth("\x1b]8;;url\x07hello", { countAnsiEscapeCodes: false }));

const str = "\x1b]8;;url\x07hello\x1b]8;;\x07";
console.log(Bun.stringWidth(str, { countAnsiEscapeCodes: false, ambiguousIsNarrow: true }));

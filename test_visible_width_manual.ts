const str = "| common | \x1b]8;;file:///tmp/DisplayTypeEnum.java\x07`DisplayTypeEnum.java`\x1b]8;;\x07 | Added display type |";
console.log(Bun.stringWidth(str, { countAnsiEscapeCodes: false, ambiguousIsNarrow: true }));

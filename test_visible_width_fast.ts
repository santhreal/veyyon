import { visibleWidth } from "./packages/tui/src/utils.ts";
const line = "| common | \x1b]8;;file:///tmp/DisplayTypeEnum.java\x07`DisplayTypeEnum.java`\x1b]8;;\x07 | Added display type |";
console.log(line.includes("\x1b"));
console.log(visibleWidth(line));

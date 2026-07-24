import { visibleWidth } from "./packages/tui/src/utils.ts";

const oscLine = "\x1b[32m\x1b]66;s=2:v=0;Hello\x1b\\\x1b[39m";
console.log(visibleWidth(oscLine));
console.log(Bun.stringWidth(oscLine, { countAnsiEscapeCodes: false, ambiguousIsNarrow: true }));

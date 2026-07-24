import { visibleWidth } from "./packages/tui/src/utils.ts";

const st = "\x1b\\";
const fileLink = `\x1b]8;;file:///tmp/DisplayTypeEnum.java${st}\`DisplayTypeEnum.java\`\x1b]8;;${st}`;
const line = `| common | ${fileLink} | Added display type |`;

const OSC8_ST_PREFIX_REGEX = /(\x1b\]8;[^\x07\x1b]*)\x1b\\/g;
function normalizeOsc8Terminators(text: string): string {
	return text.replace(OSC8_ST_PREFIX_REGEX, "$1\x07");
}

console.log("visibleWidth(line) =", visibleWidth(line));
const normalized = normalizeOsc8Terminators(line);
console.log("visibleWidth(normalized) =", visibleWidth(normalized));

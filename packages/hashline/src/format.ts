import type { Cursor } from "./types";

export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";

export const HL_PAYLOAD_REPLACE = "+";

export const HL_REPLACE_KEYWORD = "SWAP";
export const HL_DELETE_KEYWORD = "DEL";
export const HL_INSERT_KEYWORD = "INS";
export const HL_INSERT_BEFORE = "PRE";
export const HL_INSERT_AFTER = "POST";
export const HL_INSERT_HEAD = "HEAD";
export const HL_INSERT_TAIL = "TAIL";
export const HL_REPLACE_BLOCK_KEYWORD = "SWAP.BLK";
export const HL_DELETE_BLOCK_KEYWORD = "DEL.BLK";
export const HL_INSERT_AFTER_BLOCK_KEYWORD = "INS.BLK.POST";
export const HL_REM_KEYWORD = "REM";
export const HL_MOVE_KEYWORD = "MV";
export const HL_HEADER_COLON = ":";

export const HL_FILE_HASH_SEP = "#";

export const HL_RANGE_SEP = ".=";

export const HL_LINE_BODY_SEP = ":";

function regexEscape(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const HL_LINE_RE_RAW = `[1-9]\\d*`;

export const HL_LINE_CAPTURE_RE_RAW = `(${HL_LINE_RE_RAW})`;

export function formatReplaceHeader(start: number, end: number): string {
	return `${HL_REPLACE_KEYWORD} ${start}${HL_RANGE_SEP}${end}${HL_HEADER_COLON}`;
}

export function formatDeleteHeader(start: number, end = start): string {
	return start === end ? `${HL_DELETE_KEYWORD} ${start}` : `${HL_DELETE_KEYWORD} ${start}${HL_RANGE_SEP}${end}`;
}

export function formatInsertHeader(cursor: Cursor): string {
	switch (cursor.kind) {
		case "before_anchor":
			return `${HL_INSERT_KEYWORD}.${HL_INSERT_BEFORE} ${cursor.anchor.line}${HL_HEADER_COLON}`;
		case "after_anchor":
			return `${HL_INSERT_KEYWORD}.${HL_INSERT_AFTER} ${cursor.anchor.line}${HL_HEADER_COLON}`;
		case "bof":
			return `${HL_INSERT_KEYWORD}.${HL_INSERT_HEAD}${HL_HEADER_COLON}`;
		case "eof":
			return `${HL_INSERT_KEYWORD}.${HL_INSERT_TAIL}${HL_HEADER_COLON}`;
	}
}

export const HL_FILE_HASH_LENGTH = 4;
export const HL_FILE_HASH_RE_RAW = `[0-9A-F]{${HL_FILE_HASH_LENGTH}}`;
export const HL_FILE_HASH_CAPTURE_RE_RAW = `(${HL_FILE_HASH_RE_RAW})`;
export const HL_LINE_BODY_SEP_RE_RAW = regexEscape(HL_LINE_BODY_SEP);
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"] as const;
function normalizeFileHashText(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}
export function computeFileHash(text: string): string {
	const normalized = normalizeFileHashText(text);
	const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff;
	return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase();
}

export function describeAnchorExamples(linePrefix = ""): string {
	const examples = linePrefix ? [linePrefix, `${linePrefix.slice(0, -1) || "4"}2`, "7"] : ["160", "42", "7"];
	return examples.map(e => `"${e}"`).join(", ");
}

export function formatHashlineHeader(filePath: string, fileHash: string): string {
	return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`;
}

export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatNumberedLine(startLine + i, line)).join("\n");
}

import { HL_RANGE_SEP } from "./format";
import type { BlockTarget, ParsedRange } from "./tokenizer";
import type { Anchor } from "./types";

export function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(
			`line ${lineNum}: range ${range.start.line}${HL_RANGE_SEP}${range.end.line} ends before it starts.`,
		);
	}
}

export function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) anchors.push({ line });
	return anchors;
}

export function isSkippableCommentLine(line: string): boolean {
	return line.trimStart().startsWith("#");
}

export const BARE_LITERAL_VALUE_RE = /^\s*(?:"[^"]*"|'[^']*'|[-+]?\d+(?:\.\d+)?|true|false|null)\s*,?\s*$/;

export function detectApplyPatchContamination(text: string, _hasPending: boolean): string | null {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return null;
	if (
		trimmed.startsWith("*** Update File:") ||
		trimmed.startsWith("*** Add File:") ||
		trimmed.startsWith("*** Delete File:") ||
		trimmed.startsWith("*** Move to:")
	) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. ` +
			"File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). " +
			`Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
		);
	}
	if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
		return (
			"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
			`Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
		);
	}
	if (trimmed.startsWith("@@")) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. ` +
			`Drop the \`@@ ... @@\` brackets and write a verb header such as \`SWAP N${HL_RANGE_SEP}M:\`.`
		);
	}
	if (/^DEL\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?\s*:/.test(trimmed)) {
		return `\`DEL N${HL_RANGE_SEP}M\` has no colon and no body. Remove the colon and body rows.`;
	}
	if (/^[1-9]\d*\s*$/.test(trimmed)) {
		return `hunk headers need a verb. Use \`SWAP ${trimmed}${HL_RANGE_SEP}${trimmed}:\` to replace, or \`DEL ${trimmed}\` to delete.`;
	}
	const bareRange = /^([1-9]\d*)\s*[-. …=]+\s*([1-9]\d*)\s*:?$/.exec(trimmed);
	if (bareRange !== null) {
		return (
			`bare range hunk header ${JSON.stringify(trimmed)} is not valid. ` +
			`Hunk headers need a verb: write \`SWAP ${bareRange[1]}${HL_RANGE_SEP}${bareRange[2]}:\` or \`DEL ${bareRange[1]}${HL_RANGE_SEP}${bareRange[2]}\`.`
		);
	}
	return null;
}

export interface PendingComment {
	lineNum: number;
	text: string;
}

export type PayloadRow = { kind: "literal"; text: string; lineNum: number; bare?: boolean };

export interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
	deferredBlanks: PayloadRow[];
}

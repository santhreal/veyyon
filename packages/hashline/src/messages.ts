import { formatNumberedLine, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_RANGE_SEP } from "./format";

export const MISMATCH_CONTEXT = 2;

export function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
	const displayLines = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > fileLines.length) continue;
		const lo = Math.max(1, line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
		for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
	}
	const anchorSet = new Set(anchorLines);
	const rows: string[] = [];
	let previous = -1;
	for (const lineNum of Array.from(displayLines).sort((a, b) => a - b)) {
		if (previous !== -1 && lineNum > previous + 1) rows.push("...");
		previous = lineNum;
		const marker = anchorSet.has(lineNum) ? "*" : " ";
		rows.push(`${marker}${formatNumberedLine(lineNum, fileLines[lineNum - 1] ?? "")}`);
	}
	return rows;
}

export const BEGIN_PATCH_MARKER = "*** Begin Patch";

export const END_PATCH_MARKER = "*** End Patch";

export const ABORT_MARKER = "*** Abort";

export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";

export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.";

export const EMPTY_REPLACE = `\`SWAP N${HL_RANGE_SEP}M:\` needs at least one \`+TEXT\` body row. To delete lines, use \`DEL N${HL_RANGE_SEP}M\`.`;

export const EMPTY_BLOCK = "`SWAP.BLK N:` needs at least one `+TEXT` body row. To delete a block, use `DEL.BLK N`.";

export function blockUnresolvedMessage(
	line: number,
	op: "replace" | "delete" = "replace",
	fileLines?: readonly string[],
): string {
	const phrase = op === "delete" ? `DEL.BLK ${line}` : `SWAP.BLK ${line}:`;
	const fallback = op === "delete" ? `DEL ${line}${HL_RANGE_SEP}M` : `SWAP ${line}${HL_RANGE_SEP}M:`;
	let message =
		`\`${phrase}\` could not resolve a syntactic block beginning on line ${line} ` +
		`(unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
	if (fileLines) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

export const BLOCK_RESOLVER_UNAVAILABLE =
	"`SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` are not available here (no block resolver configured). Use a concrete line range.";

export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return `\`INS.BLK.POST ${line}:\` anchors on a closing delimiter, so it was applied as plain \`INS.POST ${line}:\`. Anchor on the line that OPENS the construct.`;
}

export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return `\`INS.BLK.POST ${line}:\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`INS.POST ${line}:\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}
export function ambiguousBoundaryEchoMessage(
	startLine: number,
	endLine: number,
	side: "leading" | "trailing",
	count: number,
): string {
	const where =
		side === "leading"
			? `opens by restating the ${count} line(s) just above the range`
			: `ends by restating the ${count} line(s) just below the range`;
	return (
		`\`SWAP ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: the body ${where}, ` +
		`but is too short to be the full final content of the widened range — applying it as-is or ` +
		`auto-repairing would delete range line(s) the body never restates. ` +
		`Re-issue with the range covering exactly the lines that change and the body as their complete ` +
		`final content: drop the restated keeper from the body, or widen the range to consume it.`
	);
}

export function ambiguousCloserSpareMessage(
	startLine: number,
	endLine: number,
	closerLine: number,
	count: number,
): string {
	const closers = count === 1 ? `line ${closerLine}` : `lines ${closerLine}-${closerLine + count - 1}`;
	return (
		`\`SWAP ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: the range deletes the closing-delimiter ` +
		`${closers} but the body never restates it, and the body claims no position inside that block ` +
		`(no unmatched opener, indentation not deeper than the closer) — whether the new content belongs ` +
		`before or after the closer is ambiguous. Restate the closer in the body at the intended position, ` +
		`or use \`INS.PRE ${closerLine}:\` / \`INS.POST ${closerLine}:\` instead.`
	);
}

export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved `SWAP.BLK` edit reached the applier (resolveBlockEdits was not run).";

export const DELETE_TAKES_NO_BODY = `\`DEL N${HL_RANGE_SEP}M\` does not take body rows. Remove the body, or use \`SWAP N${HL_RANGE_SEP}M:\`.`;

export const REM_TAKES_NO_BODY =
	"`REM` deletes the whole file and takes no body rows or line ops. Issue it alone under the header.";

export const MOVE_TAKES_NO_BODY =
	"`MV DEST` does not take body rows. Put line edits above the `MV` row; the destination path follows `MV` on the same line.";

export const DELETE_BLOCK_TAKES_NO_BODY = "`DEL.BLK N` does not take body rows. Remove the body, or use `SWAP.BLK N:`.";

export const EMPTY_INSERT = "`INS` needs at least one `+TEXT` body row.";

export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	return `INS.POST ${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${crossed === 1 ? "" : "s"} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`;
}

export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
	return `INS.BLK.POST ${blockStart}: body indented deeper than closing line ${closerLine}, so it was placed inside the block, after line ${landingLine}. \`INS.BLK.POST\` lands AFTER the block at sibling depth — if inside was intended, use plain \`INS.POST ${closerLine}:\`.`;
}

export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";

export const RECOVERY_LINE_REMAP_WARNING =
	"Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";

export const HEADTAIL_DRIFT_WARNING =
	"Applied the `INS.HEAD:`/`INS.TAIL:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

export function missingSnapshotTagMessage(sectionPath: string): string {
	return `Missing hashline snapshot tag for ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}\` from your latest read/search output. To create a new file, use the write tool.`;
}

export function pathRecoveredFromTagMessage(authoredPath: string, resolvedPath: string, tag: string): string {
	return (
		`Path "${authoredPath}" does not exist; matched its filename and snapshot tag ` +
		`${HL_FILE_HASH_SEP}${tag} to ${resolvedPath} (read earlier this session). Anchor future edits on ` +
		`${HL_FILE_PREFIX}${resolvedPath}${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}.`
	);
}

function formatLineRanges(lines: readonly number[]): string {
	const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
	if (sorted.length === 0) return "";
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const current = sorted[i];
		if (current === prev + 1) {
			prev = current;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = current;
		prev = current;
	}
	return parts.join(", ");
}

export interface RevealedLine {
	line: number;
	text: string;
}

export interface UnseenLinesReveal {
	lines: readonly RevealedLine[];
	truncated: boolean;
	overCap?: boolean;
	columnClipped?: boolean;
}

export function unseenLinesMessage(
	sectionPath: string,
	unseenLines: readonly number[],
	tag: string,
	reveal: UnseenLinesReveal = { lines: [], truncated: false },
): string {
	const ranges = formatLineRanges(unseenLines);
	const selector = ranges.replace(/, /g, ",");
	const header =
		`This edit anchors to lines ${ranges} of ${sectionPath} that ` +
		`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} never displayed (it showed a ` +
		`partial range, a search hit, or a folded summary).`;
	if (reveal.lines.length === 0) {
		return (
			`${header} Re-read them in full first with a ranged read like ` +
			`\`${sectionPath}:${selector}\` — it skips summarization and mints a fresh tag (a plain re-read just re-folds ` +
			`them) — then re-issue the edit.`
		);
	}
	const preview = reveal.lines.map(({ line, text }) => `  ${formatNumberedLine(line, text)}`).join("\n");
	if (reveal.truncated) {
		const remedy = reveal.columnClipped
			? `At least one of those lines is too wide to show in full here, and a ranged re-read applies the same ` +
				`column cap — read it verbatim with \`${sectionPath}:${selector}:raw\` before re-issuing the edit.`
			: `The range exceeds the inline preview cap — re-read the remainder with \`${sectionPath}:${selector}\` ` +
				`before re-issuing the edit.`;
		return (
			`${header} Preview of the actual file content at the first ${reveal.lines.length} unseen line(s):\n${preview}\n` +
			remedy
		);
	}
	return (
		`${header} Actual file content at those lines:\n${preview}\n` +
		`Verify the content matches what you intend to touch, then re-issue the edit with the same ` +
		`${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX} header — a straight retry now succeeds without a re-read. ` +
		`If the content does NOT match, fix your line numbers.`
	);
}

export type BlockOp = "replace" | "delete" | "insert_after";

export function blockSingleLineMessage(line: number, op: BlockOp): string {
	const blockForm = op === "insert_after" ? "INS.BLK.POST" : op === "delete" ? "DEL.BLK" : "SWAP.BLK";
	const plainForm =
		op === "insert_after"
			? `INS.POST ${line}:`
			: op === "delete"
				? `DEL ${line}`
				: `SWAP ${line}${HL_RANGE_SEP}${line}:`;
	return (
		`\`${blockForm} ${line}\` resolved a single-line block — line ${line} is a bare statement, not the opening line ` +
		`of a multi-line construct. For that one line use \`${plainForm}\`; to act on an enclosing construct, anchor ${blockForm} ` +
		`on the line that OPENS it (e.g. its \`function\`/\`if\`/\`case\` header), never a statement inside it.`
	);
}

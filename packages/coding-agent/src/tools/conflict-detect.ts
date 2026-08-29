import { formatCount } from "@veyyon/utils/format";
import type { ConflictBlock, ConflictEntry } from "./conflict-detect-helpers";
import { BASE_PREFIX, OURS_PREFIX, SEPARATOR, THEIRS_PREFIX } from "./conflict-detect-helpers";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

export { scanConflictLines, scanFileForConflicts } from "./conflict-detect-helpers";
export type { ConflictEntry };

export class ConflictHistory {
	#nextId = 1;
	#entries = new Map<number, ConflictEntry>();

	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.#entries.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
				const merged: ConflictEntry = { ...input, id: existing.id };
				this.#entries.set(existing.id, merged);
				return merged;
			}
		}
		const id = this.#nextId++;
		const entry: ConflictEntry = { ...input, id };
		this.#entries.set(id, entry);
		return entry;
	}

	get(id: number): ConflictEntry | undefined {
		return this.#entries.get(id);
	}

	entries(): ConflictEntry[] {
		return Array.from(this.#entries.values());
	}

	invalidate(id: number): void {
		this.#entries.delete(id);
	}

	invalidatePath(absolutePath: string): void {
		for (const [id, entry] of this.#entries) {
			if (entry.absolutePath === absolutePath) {
				this.#entries.delete(id);
			}
		}
	}
}

export function getConflictHistory(session: ToolSession): ConflictHistory {
	if (!session.conflictHistory) session.conflictHistory = new ConflictHistory();
	return session.conflictHistory;
}

export type ConflictScope = "ours" | "theirs" | "base";

const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);

export interface ParsedConflictUri {
	id: number | "*";
	scope?: ConflictScope;
	recoveredPrefix?: string;
}

const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/;

export function parseConflictUri(raw: string): ParsedConflictUri | null {
	const match = raw.match(CONFLICT_URI_RE);
	if (!match) return null;
	const recoveredPrefix = match[1];
	const tail = match[2];
	const slashIdx = tail.indexOf("/");
	const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
	const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

	if (idPart === "*") {
		if (scopePart !== undefined) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment. Drop '/${scopePart}' or use a numeric id.`,
			);
		}
		return recoveredPrefix !== undefined ? { id: "*", recoveredPrefix } : { id: "*" };
	}

	if (!/^\d+$/.test(idPart)) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*' where N is a positive integer surfaced by a prior \`read\`.`,
		);
	}
	const id = Number.parseInt(idPart, 10);
	if (!Number.isFinite(id) || id < 1) {
		throw new ToolError(`Invalid conflict URI '${raw}': id must be ≥ 1.`);
	}

	let scope: ConflictScope | undefined;
	if (scopePart !== undefined) {
		if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted (e.g. 'conflict://${id}/theirs').`,
			);
		}
		scope = scopePart as ConflictScope;
	}

	return recoveredPrefix !== undefined ? { id, scope, recoveredPrefix } : { id, scope };
}

export interface ConflictSplice {
	text: string;
	trimmedLeading: number;
	trimmedTrailing: number;
}

export function spliceConflict(originalText: string, entry: ConflictEntry, replacement: string): ConflictSplice {
	const lines = originalText.split("\n");
	const expected = buildRecordedRegion(entry);
	const match = locateRegion(lines, expected, entry.startLine - 1);
	if (!match) {
		throw new ToolError(
			`Conflict #${entry.id} no longer present in '${entry.displayPath}': the recorded marker block can't be located. The file changed since the conflict was registered — re-read it to re-register conflicts.`,
		);
	}

	const trimmed = normalizeTrailingNewline(replacement);
	let replacementLines = trimmed.split("\n").map(stripTrailingCr);
	const echo = trimBoundaryEcho(replacementLines, lines, match, entry);
	replacementLines = echo.lines;
	if (lines[match.startIdx]!.endsWith("\r")) {
		const hasFollowingLine = match.endIdx + 1 < lines.length;
		replacementLines = replacementLines.map((l, i) =>
			i < replacementLines.length - 1 || hasFollowingLine ? `${l}\r` : l,
		);
	}
	const next = lines.slice(0, match.startIdx).concat(replacementLines, lines.slice(match.endIdx + 1));
	return { text: next.join("\n"), trimmedLeading: echo.leading, trimmedTrailing: echo.trailing };
}

const MAX_ECHO_LINES = 12;

function delimiterBalance(lines: readonly string[]): number {
	let balance = 0;
	for (const line of lines) {
		for (let i = 0; i < line.length; i++) {
			const ch = line.charCodeAt(i);
			if (ch === 123 /* { */ || ch === 40 /* ( */ || ch === 91 /* [ */) balance++;
			else if (ch === 125 /* } */ || ch === 41 /* ) */ || ch === 93 /* ] */) balance--;
		}
	}
	return balance;
}

function trimBoundaryEcho(
	replacement: string[],
	fileLines: readonly string[],
	match: { startIdx: number; endIdx: number },
	entry: ConflictBlock,
): { lines: string[]; leading: number; trailing: number } {
	const oursBalance = delimiterBalance(entry.oursLines);
	const expectedBalance = oursBalance === delimiterBalance(entry.theirsLines) ? oursBalance : null;
	const singleEchoJustified = (lines: string[], without: string[]) =>
		expectedBalance !== null &&
		delimiterBalance(lines) !== expectedBalance &&
		delimiterBalance(without) === expectedBalance;

	let lines = replacement;
	let trailing = 0;
	const after: string[] = [];
	for (let i = match.endIdx + 1; i < fileLines.length && after.length < MAX_ECHO_LINES; i++) {
		after.push(stripTrailingCr(fileLines[i]!));
	}
	for (let k = Math.min(after.length, lines.length - 1); k >= 1; k--) {
		if (!after.slice(0, k).every((line, i) => lines[lines.length - k + i] === line)) continue;
		if (k >= 2 || singleEchoJustified(lines, lines.slice(0, -1))) {
			trailing = k;
			lines = lines.slice(0, lines.length - k);
		}
		break;
	}

	let leading = 0;
	const before: string[] = [];
	for (let i = match.startIdx - 1; i >= 0 && before.length < MAX_ECHO_LINES; i--) {
		before.unshift(stripTrailingCr(fileLines[i]!));
	}
	for (let k = Math.min(before.length, lines.length - 1); k >= 1; k--) {
		if (!before.slice(before.length - k).every((line, i) => lines[i] === line)) continue;
		if (k >= 2 || singleEchoJustified(lines, lines.slice(1))) {
			leading = k;
			lines = lines.slice(k);
		}
		break;
	}

	return { lines, leading, trailing };
}

function buildRecordedRegion(entry: ConflictBlock): string[] {
	const out: string[] = [];
	out.push(entry.oursLabel ? `${OURS_PREFIX} ${entry.oursLabel}` : OURS_PREFIX);
	for (let li = 0; li < entry.oursLines.length; li++) out.push(entry.oursLines[li]!);
	if (entry.baseLines !== undefined) {
		out.push(entry.baseLabel ? `${BASE_PREFIX} ${entry.baseLabel}` : BASE_PREFIX);
		for (let li = 0; li < entry.baseLines.length; li++) out.push(entry.baseLines[li]!);
	}
	out.push(SEPARATOR);
	for (let li = 0; li < entry.theirsLines.length; li++) out.push(entry.theirsLines[li]!);
	out.push(entry.theirsLabel ? `${THEIRS_PREFIX} ${entry.theirsLabel}` : THEIRS_PREFIX);
	return out;
}

export function conflictRegionsEqual(a: ConflictBlock, b: ConflictBlock): boolean {
	const ra = buildRecordedRegion(a);
	const rb = buildRecordedRegion(b);
	if (ra.length !== rb.length) return false;
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return false;
	}
	return true;
}

export function conflictRegionPresent(content: string, entry: ConflictBlock): boolean {
	const region = buildRecordedRegion(entry).join("\n");
	const normalized = content.includes("\r") ? content.replace(/\r\n/g, "\n") : content;
	return normalized.includes(region);
}

function locateRegion(
	lines: readonly string[],
	expected: readonly string[],
	preferredIdx: number,
): { startIdx: number; endIdx: number } | null {
	if (expected.length === 0 || expected.length > lines.length) return null;
	if (preferredIdx >= 0 && matchesAt(lines, preferredIdx, expected)) {
		return { startIdx: preferredIdx, endIdx: preferredIdx + expected.length - 1 };
	}
	let best: number | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	const limit = lines.length - expected.length;
	for (let i = 0; i <= limit; i++) {
		if (!matchesAt(lines, i, expected)) continue;
		const dist = Math.abs(i - preferredIdx);
		if (dist < bestDist) {
			best = i;
			bestDist = dist;
		}
	}
	if (best === null) return null;
	return { startIdx: best, endIdx: best + expected.length - 1 };
}

function matchesAt(lines: readonly string[], startIdx: number, expected: readonly string[]): boolean {
	if (startIdx < 0 || startIdx + expected.length > lines.length) return false;
	for (let i = 0; i < expected.length; i++) {
		if (stripTrailingCr(lines[startIdx + i]!) !== expected[i]) return false;
	}
	return true;
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function normalizeTrailingNewline(replacement: string): string {
	if (replacement.endsWith("\r\n")) return replacement.slice(0, -2);
	if (replacement.endsWith("\n")) return replacement.slice(0, -1);
	return replacement;
}

export function expandContentTokens(content: string, entry: ConflictEntry): string {
	const inputLines = content.split("\n");
	const out: string[] = [];
	for (const rawLine of inputLines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		switch (line) {
			case "@ours":
				for (let li = 0; li < entry.oursLines.length; li++) out.push(entry.oursLines[li]!);
				break;
			case "@theirs":
				for (let li = 0; li < entry.theirsLines.length; li++) out.push(entry.theirsLines[li]!);
				break;
			case "@base":
				if (!entry.baseLines) {
					throw new ToolError(
						`Conflict #${entry.id} has no base section (2-way merge). \`@base\` is only valid for diff3 conflicts.`,
					);
				}
				for (let li = 0; li < entry.baseLines.length; li++) out.push(entry.baseLines[li]!);
				break;
			case "@both":
				for (let li = 0; li < entry.oursLines.length; li++) out.push(entry.oursLines[li]!);
				for (let li = 0; li < entry.theirsLines.length; li++) out.push(entry.theirsLines[li]!);
				break;
			default:
				out.push(rawLine);
				break;
		}
	}
	return out.join("\n");
}

function markerLine(prefix: string, label: string | undefined): string {
	return label && label.length > 0 ? `${prefix} ${label}` : prefix;
}

export function renderConflictRegion(
	entry: ConflictEntry,
	scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
	if (scope === "ours") {
		return { lines: entry.oursLines.slice(), startLine: entry.startLine + 1 };
	}
	if (scope === "theirs") {
		return { lines: entry.theirsLines.slice(), startLine: entry.separatorLine + 1 };
	}
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined) {
			throw new ToolError(
				`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
			);
		}
		return { lines: entry.baseLines.slice(), startLine: entry.baseLine + 1 };
	}
	const out: string[] = [];
	out.push(markerLine("<<<<<<<", entry.oursLabel));
	for (let li = 0; li < entry.oursLines.length; li++) out.push(entry.oursLines[li]!);
	if (entry.baseLines !== undefined) {
		out.push(markerLine("|||||||", entry.baseLabel));
		for (let li = 0; li < entry.baseLines.length; li++) out.push(entry.baseLines[li]!);
	}
	out.push("=======");
	for (let li = 0; li < entry.theirsLines.length; li++) out.push(entry.theirsLines[li]!);
	out.push(markerLine(">>>>>>>", entry.theirsLabel));
	return { lines: out, startLine: entry.startLine };
}

const PREVIEW_SIDE_LINES = 6;

export interface FormatConflictWarningOptions {
	totalInFile?: number;
	displayPath?: string;
	scanTruncated?: boolean;
}

export function formatConflictWarning(
	entries: readonly ConflictEntry[],
	options: FormatConflictWarningOptions = {},
): string {
	if (entries.length === 0) return "";
	const total = options.totalInFile ?? entries.length;
	const partial = total > entries.length;
	const out: string[] = [];
	out.push("");
	const word = total === 1 ? "conflict" : "conflicts";
	if (partial) {
		const hintPath = options.displayPath ?? "<file>";
		out.push(
			`warn ${entries.length} of ${total} unresolved ${word} visible in this window (read \`${hintPath}:conflicts\` for the full list).`,
		);
	} else {
		out.push(`warn ${total} unresolved ${word} detected`);
	}
	if (options.scanTruncated) {
		out.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}

	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) out.push(`- ours = ${oursLabel}`);
	if (theirsLabel) out.push(`- theirs = ${theirsLabel}`);
	if (anyBase) out.push(`- base = ${baseLabel ?? "(no label)"}`);
	out.push(
		'NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` to render a single side). Resolve with `write({ path: "conflict://<N>", content })`, or bulk-resolve every registered conflict with `write({ path: "conflict://*", content })`. Writes replace ONLY the marker block (markers + all sides) — never repeat the lines before/after it; they stay in place.',
	);
	out.push(
		'`content` shorthand: a line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that recorded section. `@both` is ours-then-theirs with no separator — only for additive conflicts where each side adds something different; NEVER for competing edits of the same lines (pick a side or write the combined text). Lines that are not a token pass through verbatim, so `"// keep both\\n@ours\\n@theirs"` literally writes the comment, then ours, then theirs.',
	);
	out.push(
		'Per-id bulk: `write({ path: "conflict://*", content: "1: @ours\\n2: @theirs\\n…" })` resolves each listed id with that side in ONE call — the cheapest way through many pick-one conflicts; unlisted ids stay registered.',
	);
	out.push(
		"Resolve each block faithfully: keep one side (`@ours`/`@theirs`), or combine them when both intents apply — never invent content beyond the recorded sides, and never stack both sides of competing edits. Resolve several conflicts in a single turn by issuing multiple `write` calls at once; ids stay valid as earlier blocks are resolved.",
	);

	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		out.push("");
		out.push(`──── #${entry.id}  ${range} ────`);

		const baseEqualsOurs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.oursLines);
		const baseEqualsTheirs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.theirsLines);
		const theirsEqualsOurs = sectionsEqual(entry.theirsLines, entry.oursLines);

		out.push("<<< ours");
		appendBody(out, entry.oursLines);

		if (entry.baseLines !== undefined) {
			if (baseEqualsOurs) {
				out.push("=== base ≡ ours");
			} else if (baseEqualsTheirs) {
				out.push("=== base ≡ theirs");
			} else {
				out.push("=== base");
				appendBody(out, entry.baseLines);
			}
		}

		if (theirsEqualsOurs) {
			out.push(">>> theirs ≡ ours");
		} else {
			out.push(">>> theirs");
			appendBody(out, entry.theirsLines);
		}
	}
	return out.join("\n");
}

export function formatConflictSummary(
	entries: readonly ConflictEntry[],
	options: { displayPath: string; scanTruncated?: boolean } = { displayPath: "" },
): string {
	const lines: string[] = [];
	const total = entries.length;
	const word = total === 1 ? "conflict" : "conflicts";
	lines.push(`warn ${total} unresolved ${word} in ${options.displayPath || "<file>"}`);
	if (options.scanTruncated) {
		lines.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}
	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) lines.push(`- ours = ${oursLabel}`);
	if (theirsLabel) lines.push(`- theirs = ${theirsLabel}`);
	if (anyBase) lines.push(`- base = ${baseLabel ?? "(no label)"}`);
	lines.push(
		'NOTICE: Bulk-resolve with `write({ path: "conflict://*", content })`, or address a single block with `write({ path: "conflict://<N>", content })`. Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` for a single side).',
	);
	lines.push(
		'`content` shorthand: `@ours` / `@theirs` / `@base` / `@both` lines expand to the recorded sections; `@both` = ours-then-theirs (additive conflicts only — never for competing edits of the same lines). Per-id bulk: content of `<id>: @side` lines (e.g. "1: @ours\\n2: @theirs") resolves each listed id in one call. Non-token lines pass through verbatim. Writes replace ONLY the marker block — never repeat the surrounding lines. Keep one side or combine faithfully; never invent content beyond the recorded sides.',
	);
	lines.push("");
	const idWidth = String(entries[entries.length - 1]?.id ?? 1).length;
	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		const idCell = `#${String(entry.id).padStart(idWidth, " ")}`;
		const kind = entry.baseLines !== undefined ? "  (3-way)" : "";
		lines.push(`${idCell}  ${range}${kind}`);
	}
	return lines.join("\n");
}

function pickLabel(
	entries: readonly ConflictEntry[],
	get: (e: ConflictEntry) => string | undefined,
): string | undefined {
	for (const e of entries) {
		const label = get(e);
		if (label && label.trim().length > 0) return label;
	}
	return undefined;
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function appendBody(out: string[], section: readonly string[]): void {
	if (section.length === 0) {
		out.push("(empty)");
		return;
	}
	const shown = section.slice(0, PREVIEW_SIDE_LINES);
	for (const line of shown) out.push(line);
	const hidden = section.length - shown.length;
	if (hidden > 0) out.push(`… (${formatCount("more line", hidden)})`);
}

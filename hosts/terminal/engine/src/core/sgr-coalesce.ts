/**
 * SGR coalescing. The renderer's component tree emits a styled span as
 * `<set-color>text<reset>`, so adjacent spans produce runs of byte-adjacent
 * SGR sequences (e.g. a `CSI 39 m` fg-reset immediately followed by the next
 * span's `CSI 38;2;r;g;b m`). Two byte-adjacent SGR sequences are semantically
 * identical to one SGR carrying both parameter lists (SGR params apply
 * left-to-right), so merging the run into a single `CSI … m` is
 * behavior-preserving: it drops the redundant `ESC[`/`m` framing and lets the
 * terminal dispatch one SGR instead of several. On a real transcript ~40% of
 * all SGR sequences are collapsible this way, which meaningfully cuts the
 * per-frame byte volume and SGR-dispatch count a slow (xterm.js/WebGL) terminal
 * must process. On by default; `VEYYON_NO_SGR_COALESCE=1` disables it.
 *
 * Split out of `renderer.ts`, whose line preparation applies it to every row.
 */
import { $flag } from "@veyyon/utils/env";

const SGR_COALESCE_ENABLED = !$flag("VEYYON_NO_SGR_COALESCE");
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b; // [
const CC_M = 0x6d; // m
const CC_SEMI = 0x3b; // ;
const CC_COLON = 0x3a; // :
// Max parameter tokens per emitted merged SGR. Kept well under xterm.js's
// 32-param cap (and the tighter limits of some real terminals) so a long
// adjacent run is split into several valid CSIs instead of overflowing one.
const MERGE_TOKEN_CAP = 16;

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

// True when a parameter list ends mid extended-color spec in the ambiguous
// semicolon form: `38/48/58;2` with fewer than three channel values, or
// `38/48/58;5` with no palette index. Concatenating another list after such a
// run would let the next code be absorbed as the missing channel/index (e.g.
// `38;2;255;0` + `31` → `38;2;255;0;31`, where `31` becomes blue instead of a
// standalone fg-red), changing the rendered color. The self-delimiting colon
// form (`38:2::r:g:b`) is unambiguous — its tokens never equal a bare `38`, so
// the scan treats it as a complete unit and merging stays safe.
function endsWithIncompleteExtendedColor(params: string): boolean {
	const t = params.split(";");
	for (let i = 0; i < t.length; ) {
		const span = extendedColorTokens(t, i);
		if (span < 0) return true;
		i += span;
	}
	return false;
}

/**
 * The tokens the code at `t[i]` spans: 5 for `38/48/58;2;r;g;b`, 3 for `38/48/58;5;n`, 1 for any other code, and -1
 * when the list ends before an extended-color spec does.
 */
function extendedColorTokens(t: readonly string[], i: number): number {
	const tok = t[i];
	if (tok !== "38" && tok !== "48" && tok !== "58") return 1;
	const mode = t[i + 1];
	if (mode === undefined) return -1; // introducer with no mode
	if (mode === "2") return i + 4 >= t.length ? -1 : 5; // missing r/g/b
	if (mode === "5") return i + 2 >= t.length ? -1 : 3; // missing index
	return 1;
}

/**
 * Merge runs of byte-adjacent SGR sequences (`CSI [0-9;:]* m`) into one. Only
 * CSI-SGR sequences are touched; text, cursor moves, OSC, hyperlinks and image
 * payloads pass through verbatim. Returns the original reference when nothing
 * merges, so SGR-light lines incur only a single `indexOf` scan.
 */
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}
		// Scan a candidate SGR sequence: ESC [ <params> m.
		const j = sgrParamsEnd(line, i + 2);
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			// Not an SGR (e.g. cursor move); leave it in the pending region.
			i = j;
			continue;
		}
		// Collect the run of adjacent SGR sequences starting here.
		const params: string[] = [line.slice(i + 2, j)];
		const k = collectSgrRun(line, j + 1, params);
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);
			out += mergedSgr(params);
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}

/** The index of the first byte at or after `from` that is not an SGR parameter byte. */
function sgrParamsEnd(line: string, from: number): number {
	let j = from;
	while (j < line.length && isSgrParamByte(line.charCodeAt(j))) j++;
	return j;
}

/**
 * Append to `params` the parameter list of each SGR sequence that follows byte-adjacently from `from`; returns the
 * index after the last one.
 */
function collectSgrRun(line: string, from: number, params: string[]): number {
	const n = line.length;
	let k = from;
	while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
		const p = sgrParamsEnd(line, k + 2);
		if (p >= n || line.charCodeAt(p) !== CC_M) break;
		params.push(line.slice(k + 2, p));
		k = p + 1;
	}
	return k;
}

/**
 * The merged form of a run of SGR parameter lists. The current group is flushed
 * before a list is appended when (a) the previous list ended mid extended-color,
 * so the next code cannot be absorbed as its missing channel/index, or (b) the
 * token count would exceed MERGE_TOKEN_CAP. SGR params apply left-to-right
 * regardless of how they are grouped across adjacent CSIs, so a capped/guarded
 * split stays behavior-preserving — while a single unbounded merge would
 * overflow a terminal's CSI parameter buffer (xterm.js caps at 32 and silently
 * truncates the rest, corrupting colors). Empty params (`CSI m`) mean a full
 * reset; normalize to `0` so the merged list stays unambiguous.
 */
function mergedSgr(params: readonly string[]): string {
	let out = "";
	let group = "";
	let groupTokens = 0;
	let groupOpenSafe = true;
	for (const param of params) {
		const norm = param.length === 0 ? "0" : param;
		const tk = sgrTokenCount(norm);
		if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
			out += `\x1b[${group}m`;
			group = "";
			groupTokens = 0;
		}
		group += group.length === 0 ? norm : `;${norm}`;
		groupTokens += tk;
		groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
	}
	if (group.length > 0) out += `\x1b[${group}m`;
	return out;
}

/** The parameter tokens in an SGR list: one more than its `;` and `:` separators. */
function sgrTokenCount(params: string): number {
	let tokens = 1;
	for (let z = 0; z < params.length; z++) {
		const cc = params.charCodeAt(z);
		if (cc === CC_SEMI || cc === CC_COLON) tokens++;
	}
	return tokens;
}

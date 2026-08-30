import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AgentState } from "@veyyon/agent-core";
import type { SessionEntry, SessionHeader } from "@veyyon/kernel/session/session-entries";
import { APP_NAME, isEnoent, logger } from "@veyyon/utils";
import { atomicWriteFileWith } from "@veyyon/utils/atomic-write";
import { isSessionFileName, SESSION_BACKUP_EXTENSION, sessionFileStem } from "@veyyon/utils/session-file";
import type { SecretObfuscator } from "../../secrets/obfuscator";
import { loadEntriesFromFile } from "../../session/session-loader";
import { SessionManager } from "../../session/session-manager";
import { getResolvedThemeColors, getThemeExportColors } from "../../theme/theme";
import { redactSessionDataForShare } from "../redact-snapshot";
import markdownRendererJs from "./markdown-renderer.js";
import templateCss from "./template.css";
import templateHtml from "./template.html";
import templateJs from "./template.js";
// Pre-built React tool renderers, built by `gen:tool-views`. The file is
// gitignored, and Bun resolves this text import when this module's importer
// merely PARSES — a missing file kills boot, not just HTML export
// (source-install launch failure, 2026-07-24). Bun runs no root lifecycle
// scripts on workspace installs, so its producers are explicit: the source
// launcher self-heals it before exec (scripts/veyyon), `veyyon update`'s
// source path regenerates it, and binary builds regenerate before bundling.
import toolViewsJs from "./tool-views.generated.js";
import { EXPORT_FALLBACK_BASE_BG, webExportThemeVars } from "./web-palette";

let cachedTemplate: string | undefined;

/** Compose the standalone export template: minified CSS, tool renderers, and viewer JS inlined. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const minifiedCss = templateCss
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();
	// Function replacements so `$'`, `$&`, `$$`, etc. inside the embedded
	// CSS/JS are not interpreted as substitution patterns. The cast is safe:
	// `with { type: "text" }` yields a string at runtime; bun-types just types
	// every *.html import as HTMLBundle (TS can't vary types by import attribute).
	cachedTemplate = (templateHtml as unknown as string)
		.replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
		.replace("<template-tool-views/>", () => `<script>${toolViewsJs}</script>`)
		.replace("<template-markdown/>", () => `<script>${markdownRendererJs}</script>`)
		.replace("<template-js/>", () => `<script>${templateJs}</script>`);
	return cachedTemplate;
}

export interface ExportOptions {
	outputPath?: string;
	/**
	 * Which color palette the export ships with.
	 * - `"web"` (default) — the veyyon brand identity (collab-web pink/purple),
	 *   so public HTML exports and the `/s/<id>` share viewer match the live
	 *   `share.veyyon.dev` client. See `web-palette.ts`.
	 * - `"theme"` — derive from `themeName` (or the active TUI theme), preserving
	 *   the pre-15.12 behavior where an export mirrored the user's terminal.
	 */
	palette?: "web" | "theme";
	/**
	 * TUI theme to derive colors from when `palette: "theme"`. Ignored for the
	 * default `"web"` palette. Resolves to the active TUI theme when omitted.
	 */
	themeName?: string;
	/** Embed subagent session transcripts found next to the session file (default true). */
	includeSubSessions?: boolean;
	/**
	 * Redact secrets from the snapshot before it is written, through the same typed walk
	 * `/share` uses. An exported HTML file leaves the machine the moment the operator attaches
	 * it to a bug report, so a secret that landed in a tool output (a `.env` read, a curl with a
	 * token) must be replaced with its placeholder here too. Omit to skip redaction.
	 */
	obfuscator?: SecretObfuscator;
}

/** Parse a color string to RGB values. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color. */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	let base = baseColor;
	let parsed = parseColor(base);
	if (!parsed) {
		// An unparseable base means a malformed theme value, not a design choice.
		// Derive from the brand ground instead of inventing a tint, and say so.
		logger.warn("Theme userMessageBg is not a parseable color; deriving export surfaces from the brand ground", {
			userMessageBg: baseColor,
			fallback: EXPORT_FALLBACK_BASE_BG,
		});
		base = EXPORT_FALLBACK_BASE_BG;
		parsed = parseColor(base);
		// The brand ground is a literal hex owned in this repo, so it always parses.
		if (!parsed) throw new Error(`EXPORT_FALLBACK_BASE_BG is not a parseable color: ${EXPORT_FALLBACK_BASE_BG}`);
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	if (luminance > 0.5) {
		return {
			pageBg: adjustBrightness(base, 0.96),
			cardBg: base,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(base, 0.7),
		cardBg: adjustBrightness(base, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom properties for the export `:root`.
 *
 * Two call shapes:
 *   • `generateThemeVars("web" | "theme", themeName?)` — explicit palette.
 *     `"web"` (the default for public artifacts) returns the fixed veyyon brand
 *     palette from `web-palette.ts` — collab-web pink/purple identity, shared
 *     with the live `share.veyyon.dev` client, so exports and the share viewer render
 *     identically to it. `"theme"` derives from the TUI theme via
 *     `getResolvedThemeColors(themeName)` plus the three
 *     `export.{pageBg,cardBg,infoBg}` surface overrides.
 *   • `generateThemeVars(themeName)` — legacy single-arg form: derive from the
 *     named TUI theme. Kept so existing callers (and the theme-islight test)
 *     keep working; equivalent to `generateThemeVars("theme", themeName)`.
 *
 * Exported for the share-viewer build script.
 */
export async function generateThemeVars(
	palette: "web" | "theme" | (string & {}) = "web",
	themeName?: string,
): Promise<string> {
	// Legacy single-arg form: `generateThemeVars("my-theme")` — the first arg
	// is a theme name, not a palette. Route it to the themed path.
	if (palette !== "web" && palette !== "theme") {
		return generateThemeVars("theme", palette);
	}
	if (palette === "web") return webExportThemeVars();

	const colors = await getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const key in colors) {
		lines.push(`--${key}: ${colors[key]};`);
	}

	const themeExport = await getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || EXPORT_FALLBACK_BASE_BG;
	const derived = deriveExportColors(userMessageBg);

	lines.push(`--body-bg: ${themeExport.pageBg ?? derived.pageBg};`);
	lines.push(`--container-bg: ${themeExport.cardBg ?? derived.cardBg};`);
	lines.push(`--info-bg: ${themeExport.infoBg ?? derived.infoBg};`);

	return lines.join(" ");
}

/** Embedded subagent session transcript, keyed by slash-joined agent path in `SessionData.subSessions`. */
export interface SubSession {
	/** Bare agent id (session file stem), e.g. "ToolAsk". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
}

export interface SessionData {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	systemPrompt?: string;
	tools?: { name: string; description: string }[];
	subSessions?: Record<string, SubSession>;
}

/** Snapshot the session (plus optional agent state) into the JSON shape the viewer renders. */
export function buildSessionData(sm: SessionManager, state?: AgentState): SessionData {
	return {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt.join("\n\n"),
		tools: state?.tools?.map(t => ({ name: t.name, description: t.description })),
	};
}

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Keys in the
 * returned record are slash-joined ids relative to the main session ("ToolAsk", "ToolAsk/Helper").
 * Empty files, backups, and unrelated files are skipped. A corrupt transcript refuses the export so
 * the resulting artifact cannot silently claim to contain a complete session.
 */
export async function collectSubSessions(sessionFile: string): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!isSessionFileName(sessionFile)) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result);
	return result;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	for (const name of names) {
		if (!isSessionFileName(name) || name.includes(SESSION_BACKUP_EXTENSION)) continue;
		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const fileEntries = await loadEntriesFromFile(path.join(dir, name));
		// Empty/corrupt files (no valid session header) load as [] — skip silently.
		if (fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
			};
		}
		await collectSubSessionsFromDir(path.join(dir, agentId), key, out);
	}
}

/**
 * Split the template at the session-data marker. The marker must appear exactly
 * once; a template without it (or with two) is a build defect, not bad input.
 */
function splitTemplateAtSessionMarker(template: string): { head: string; tail: string } {
	const marker = "{{SESSION_DATA}}";
	const first = template.indexOf(marker);
	if (first < 0) throw new Error("Export template is missing the {{SESSION_DATA}} marker");
	if (template.indexOf(marker, first + 1) >= 0) throw new Error("Export template repeats the {{SESSION_DATA}} marker");
	return { head: template.slice(0, first), tail: template.slice(first + marker.length) };
}

/**
 * The builtin's `toJSON` step: a holder replaces a value with `value.toJSON(key)`
 * before serializing it, once, and never re-applies it to the result. `key` is
 * the property name, an array index as a string, or `""` at the root.
 */
function applyToJSON(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
		return value.toJSON(key);
	}
	return value;
}

/**
 * Incremental JSON serializer. Emits the same bytes `JSON.stringify(value)`
 * emits — leaf strings/numbers/booleans go through `JSON.stringify` itself,
 * object keys are visited in insertion order, and `undefined` property values
 * are skipped exactly like the builtin — but as a sequence of independent
 * string pieces, so a large graph never exists as one flat JSON string.
 *
 * Same failures too: a cycle raises a `TypeError` before anything unbounded is
 * emitted, and a BigInt raises rather than serializing to something a reader
 * would have to guess at. A root that serializes to nothing, which the builtin
 * answers with `undefined`, raises as well: there is no such document.
 */
export function* jsonPieces(value: unknown): Generator<string> {
	// The objects on the path from the root to the value being emitted. The builtin throws on a
	// cycle; without this the generator descends forever, and a caller that streams its output
	// to a file gets an unbounded write instead of an error.
	const ancestors = new Set<object>();

	const root = applyToJSON(value, "");
	if (root === undefined || typeof root === "function" || typeof root === "symbol") {
		// `JSON.stringify` answers `undefined` here, which is not JSON and cannot
		// be written to a file. A session snapshot that serializes to nothing is
		// a defect upstream, so say so rather than emitting `null` and shipping a
		// document whose payload silently became a literal null.
		throw new TypeError("A session snapshot serializes to nothing");
	}
	yield* emitValue(root);

	function* emitValue(v: unknown): Generator<string> {
		if (v === null) {
			yield "null";
			return;
		}
		switch (typeof v) {
			case "string":
				yield JSON.stringify(v);
				return;
			case "number":
				// NaN and Infinity are not representable in JSON; the builtin
				// emits them as `null`.
				yield Number.isFinite(v) ? String(v) : "null";
				return;
			case "boolean":
				yield String(v);
				return;
			case "bigint":
				throw new Error("A session snapshot value is a BigInt, which JSON cannot represent");
			case "object":
				break;
			default:
				// A symbol or function reaching here as a bare array element
				// serializes to `null`, exactly like the builtin.
				yield "null";
				return;
		}
		// No `toJSON` branch here. The builtin applies `toJSON` once, at the
		// holder that owns the value, and serializes the result as-is; applying
		// it again on the way down turns a transform returning another holder
		// (`{ toJSON: () => ({ toJSON: () => 5 }) }`) into `5` where the builtin
		// emits `{}`. `applyToJSON` is called by each holder instead.
		// A boxed primitive serializes as the primitive it wraps. Falling through to the object
		// branch would emit a String box as its index map and a Number box as `{}`.
		if (v instanceof String || v instanceof Number || v instanceof Boolean) {
			yield* emitValue(v.valueOf());
			return;
		}
		if (ancestors.has(v)) throw new TypeError("Converting circular structure to JSON");
		ancestors.add(v);
		try {
			if (Array.isArray(v)) {
				yield "[";
				for (let index = 0; index < v.length; index++) {
					if (index > 0) yield ",";
					// The builtin passes the index as the key, so an element's
					// `toJSON(key)` sees "0", "1", … and not `undefined`.
					const item = applyToJSON(v[index], String(index));
					if (item === undefined || typeof item === "function" || typeof item === "symbol") yield "null";
					else yield* emitValue(item);
				}
				yield "]";
				return;
			}
			// Own enumerable properties only; every value stays `unknown` until its
			// turn in emitValue, which narrows by runtime typeof checks.
			const source = v as Record<string, unknown>;
			yield "{";
			let first = true;
			for (const [key, raw] of Object.entries(source)) {
				const item = applyToJSON(raw, key);
				// The builtin omits undefined-, function- and symbol-valued properties.
				if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
				if (!first) yield ",";
				first = false;
				yield `${JSON.stringify(key)}:`;
				yield* emitValue(item);
			}
			yield "}";
		} finally {
			ancestors.delete(v);
		}
	}
}

/** Serialized-string characters accumulated before one Buffer encoding pass. */
const ENCODE_CHUNK_CHARS = 256 * 1024;

/**
 * Base64 sink with byte-level carry. Base64 encodes 3 bytes into 4 chars, so a
 * chunk boundary is only clean at a multiple of 3 input bytes; everything else
 * waits in `carry` for the next piece. Splitting the input at arbitrary piece
 * boundaries therefore reproduces `Buffer.from(all).toString("base64")` byte for
 * byte, while no single piece ever has to be the whole payload.
 */
export class StreamingBase64Writer {
	// Pieces are accumulated to ENCODE_CHUNK_CHARS before one Buffer round trip
	// encodes them together: per-piece Buffer.from + concat on hundreds of
	// thousands of small pieces dominated the export profile otherwise.
	#pending: string[] = [];
	#pendingChars = 0;
	#carry = Buffer.alloc(0);
	/**
	 * The sink receives base64 chunks in order and may write them however it
	 * likes (batching, promise chaining) — `push`/`end` are synchronous and
	 * never await, so the streaming loop has no per-piece async round trips.
	 */
	constructor(private readonly write: (chunk: string) => void) {}

	push(piece: string): void {
		if (piece.length === 0) return;
		this.#pending.push(piece);
		this.#pendingChars += piece.length;
		if (this.#pendingChars >= ENCODE_CHUNK_CHARS) this.#drain();
	}

	end(): void {
		this.#drain();
		if (this.#carry.length > 0) this.write(this.#carry.toString("base64"));
		this.#carry = Buffer.alloc(0);
	}

	#drain(): void {
		if (this.#pending.length === 0) return;
		const joined = this.#pending.join("");
		this.#pending = [];
		this.#pendingChars = 0;
		// The carry is raw bytes, possibly a SPLIT multi-byte character — never
		// decode it to a string; prepend it at the byte level instead.
		const bytes =
			this.#carry.length > 0
				? Buffer.concat([this.#carry, Buffer.from(joined, "utf8")])
				: Buffer.from(joined, "utf8");
		this.#carry = Buffer.alloc(0);
		const aligned = bytes.length - (bytes.length % 3);
		if (aligned > 0) this.write(bytes.subarray(0, aligned).toString("base64"));
		this.#carry = Buffer.from(bytes.subarray(aligned));
	}
}

/** How many JSON source bytes may stream before the writer yields to the event loop. */
const YIELD_BYTE_BUDGET = 4 * 1024 * 1024;

/** Base64 characters accumulated before the writer commits one file write. */
const WRITE_FLUSH_CHARS = 1024 * 1024;

/**
 * Write the standalone HTML export WITHOUT ever holding the whole document —
 * or even the whole JSON payload — in memory. The template is split at the
 * session-data marker, the head goes to disk, then the snapshot is serialized
 * piece by piece through `jsonPieces` and base64-encoded incrementally into
 * the same stream, and finally the tail closes the file. Peak memory above the
 * snapshot graph itself is one small chunk instead of several whole-payload
 * copies (JSON string + Buffer + base64 string + assembled document).
 */
async function writeExportFile(
	outputPath: string,
	sessionData: SessionData,
	palette: "web" | "theme",
	themeName?: string,
): Promise<void> {
	const themeVars = await generateThemeVars(palette, themeName);
	const templated = getTemplate().replace("<theme-vars/>", () => `<style>:root { ${themeVars} }</style>`);
	const { head: beforeData, tail } = splitTemplateAtSessionMarker(templated);

	await atomicWriteFileWith(outputPath, async tempPath => {
		const handle = await fs.open(tempPath, "w");
		try {
			await handle.write(beforeData);
			// Batch base64 chunks into ~1 MiB file writes: one awaited write per
			// serializer piece turns an 80 MiB export into hundreds of thousands of
			// async round trips (measured: 825ms -> 58s).
			let pending: string[] = [];
			let pendingChars = 0;
			// Writes are chained, never launched concurrently: two overlapping
			// handle.write calls could reorder base64 quanta and corrupt the payload.
			let writeChain: Promise<void> = Promise.resolve();
			const flushPending = (): Promise<void> => {
				if (pending.length === 0) return writeChain;
				const joined = pending.join("");
				pending = [];
				pendingChars = 0;
				writeChain = writeChain.then(() => handle.write(joined).then(() => {}));
				return writeChain;
			};
			const b64 = new StreamingBase64Writer(chunk => {
				pending.push(chunk);
				pendingChars += chunk.length;
				if (pendingChars >= WRITE_FLUSH_CHARS) void flushPending();
			});
			// Yield only after crossing a byte budget, so timers and sockets keep
			// getting service during a long export; yielding per piece measured
			// 825ms -> 65s and is exactly what this budget avoids.
			let bytesSinceYield = 0;
			for (const piece of jsonPieces(sessionData)) {
				b64.push(piece);
				bytesSinceYield += Buffer.byteLength(piece, "utf8");
				if (bytesSinceYield >= YIELD_BYTE_BUDGET) {
					bytesSinceYield = 0;
					await flushPending();
					await setImmediate();
				}
			}
			b64.end();
			await flushPending();
			await handle.write(tail);
		} finally {
			await handle.close();
		}
	});
}

/** Export session to HTML using SessionManager and AgentState. */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Cannot export in-memory session to HTML");

	const sessionData = buildSessionData(sm, state);
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectSubSessions(sessionFile);
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}

	// After sub-sessions are attached: a subagent transcript carries the same tool output the
	// primary one does, so redacting before the merge would leave the child's copy verbatim.
	const redacted = opts.obfuscator?.hasSecrets()
		? redactSessionDataForShare(opts.obfuscator, sessionData)
		: sessionData;
	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const outputPath = opts.outputPath || `${APP_NAME}-session-${sessionFileStem(path.basename(sessionFile))}.html`;
	await writeExportFile(outputPath, redacted, palette, opts.themeName);
	return outputPath;
}

/** Export session file to HTML (standalone). */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	let sm: SessionManager;
	try {
		sm = await SessionManager.open(inputPath, undefined, undefined, { suppressBreadcrumb: true });
	} catch (err) {
		if (isEnoent(err)) throw new Error(`File not found: ${inputPath}`);
		throw err;
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
	};
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectSubSessions(inputPath);
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}

	const redacted = opts.obfuscator?.hasSecrets()
		? redactSessionDataForShare(opts.obfuscator, sessionData)
		: sessionData;
	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const outputPath = opts.outputPath || `${APP_NAME}-session-${sessionFileStem(path.basename(inputPath))}.html`;
	await writeExportFile(outputPath, redacted, palette, opts.themeName);
	return outputPath;
}

import { parse as parseToml } from "smol-toml";
import {
	DEFAULT_SIGIL,
	HANDLE_NAME_RE,
	MAX_EXPANSION_BYTES,
	SIGIL_FORBIDDEN_RE,
	SUPPORTED_VERSION,
} from "./constants.js";
import type { HandleMeta, Vocabulary } from "./types.js";

/**
 * Thrown when an `AGENTS.dict` is present but malformed. Argot never silently
 * downgrades a broken dict to an empty one: a repo that ships a dictionary and
 * gets no expansion is a worse failure than a loud parse error.
 */
export class ArgotParseError extends Error {
	/** The file the dict was read from, for the operator's message. */
	readonly source: string;

	constructor(message: string, source: string) {
		super(`${source}: ${message}`);
		this.name = "ArgotParseError";
		this.source = source;
	}
}

const utf8 = new TextEncoder();

/** Shape of the raw TOML table, before validation. */
interface RawDict {
	version?: unknown;
	sigil?: unknown;
	handles?: unknown;
	meta?: unknown;
}

/**
 * Parse and fully validate an `AGENTS.dict`. Every rule fails loud with a
 * message that names the offending key and the fix. `source` is the path used
 * in error messages.
 */
export function parseDict(content: string, source: string): Vocabulary {
	let raw: RawDict;
	try {
		raw = parseToml(content) as RawDict;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new ArgotParseError(`invalid TOML: ${detail}`, source);
	}

	const version = parseVersion(raw.version, source);
	const sigil = parseSigil(raw.sigil, source);
	const handles = parseHandles(raw.handles, sigil, source);
	const meta = parseMeta(raw.meta, handles, source);

	return { version, sigil, handles, meta };
}

function parseVersion(value: unknown, source: string): number {
	if (value === undefined) {
		throw new ArgotParseError("missing `version` (expected `version = 1`)", source);
	}
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new ArgotParseError("`version` must be an integer", source);
	}
	if (value < 1) {
		throw new ArgotParseError("`version` must be >= 1", source);
	}
	if (value > SUPPORTED_VERSION) {
		throw new ArgotParseError(
			`file targets version ${value} but this loader understands version ${SUPPORTED_VERSION}; upgrade argot`,
			source,
		);
	}
	return value;
}

function parseSigil(value: unknown, source: string): string {
	if (value === undefined) {
		// Sigil is optional. A missing one takes the default so the vocabulary is
		// always complete and the codec has exactly one marker to key on.
		return DEFAULT_SIGIL;
	}
	if (typeof value !== "string") {
		throw new ArgotParseError("`sigil` must be a string", source);
	}
	if (value.length === 0) {
		throw new ArgotParseError("`sigil` must not be empty", source);
	}
	if (SIGIL_FORBIDDEN_RE.test(value)) {
		throw new ArgotParseError("`sigil` must not contain letters, digits, underscores, or whitespace", source);
	}
	return value;
}

function parseHandles(value: unknown, sigil: string, source: string): Map<string, string> {
	if (value === undefined) {
		throw new ArgotParseError("missing `[handles]` table", source);
	}
	if (!isPlainTable(value)) {
		throw new ArgotParseError("`[handles]` must be a table", source);
	}

	const handles = new Map<string, string>();
	for (const [name, expansion] of Object.entries(value)) {
		if (!HANDLE_NAME_RE.test(name)) {
			throw new ArgotParseError(
				`handle name "${name}" must match [a-z0-9_]+ (lowercase letters, digits, underscores)`,
				source,
			);
		}
		if (typeof expansion !== "string") {
			throw new ArgotParseError(`handle "${name}" must expand to a string`, source);
		}
		if (expansion.length === 0) {
			throw new ArgotParseError(`handle "${name}" must not expand to an empty string`, source);
		}
		const bytes = utf8.encode(expansion).length;
		if (bytes > MAX_EXPANSION_BYTES) {
			throw new ArgotParseError(
				`handle "${name}" expands to ${bytes} bytes, over the ${MAX_EXPANSION_BYTES}-byte limit; a handle stands for a recurring string, not a document`,
				source,
			);
		}
		if (expansion.includes(sigil)) {
			throw new ArgotParseError(
				`handle "${name}" expands to text containing the sigil "${sigil}"; an expansion must not contain the sigil, so that expansion stays a single lossless pass and no handle can expand into another`,
				source,
			);
		}
		handles.set(name, expansion);
	}

	if (handles.size === 0) {
		throw new ArgotParseError("`[handles]` defines no handles", source);
	}
	return handles;
}

function parseMeta(value: unknown, handles: Map<string, string>, source: string): Map<string, HandleMeta> {
	const meta = new Map<string, HandleMeta>();
	if (value === undefined) {
		return meta;
	}
	if (!isPlainTable(value)) {
		throw new ArgotParseError("`[meta]` must be a table", source);
	}

	for (const [name, entry] of Object.entries(value)) {
		if (!handles.has(name)) {
			throw new ArgotParseError(
				`[meta.${name}] refers to a handle "${name}" that is not defined in [handles]`,
				source,
			);
		}
		if (!isPlainTable(entry)) {
			throw new ArgotParseError(`[meta.${name}] must be a table`, source);
		}
		const parsed: HandleMeta = {};
		if (entry.note !== undefined) {
			if (typeof entry.note !== "string") {
				throw new ArgotParseError(`[meta.${name}].note must be a string`, source);
			}
			parsed.note = entry.note;
		}
		if (entry.scope !== undefined) {
			if (typeof entry.scope !== "string") {
				throw new ArgotParseError(`[meta.${name}].scope must be a string`, source);
			}
			parsed.scope = entry.scope;
		}
		meta.set(name, parsed);
	}
	return meta;
}

/** A plain TOML table: a non-null, non-array object. */
function isPlainTable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

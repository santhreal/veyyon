import * as crypto from "node:crypto";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Message,
	type TextContent,
	type Tool,
	toolWireSchema,
} from "@veyyon/ai";
import { errorMessage } from "@veyyon/utils";
import type { SessionContext } from "../session/session-context";
import {
	buildNamePlaceholder,
	buildValuePlaceholder,
	isSecretPlaceholder,
	isValidSecretName,
	isWellFormedUtf16,
	PLACEHOLDER_RE,
} from "./placeholder";
import {
	canObfuscatePlainValue,
	MIN_OBFUSCATABLE_LENGTH,
	secretCharacterLength,
	type SecretRejection,
} from "./policy";
import { compileSecretRegex } from "./regex";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface SecretEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
	/**
	 * Shortest match this entry will obfuscate, overriding
	 * {@link MIN_OBFUSCATABLE_LENGTH} for a `regex` entry that legitimately matches
	 * short values.
	 *
	 * Exists so the floor is a declared choice rather than a magic number the author
	 * cannot reach. A pattern written for a six-character one-time code is a real case,
	 * and the default floor exists only because a loose pattern would otherwise blank
	 * out fragments of ordinary words. Lower it deliberately and the entry says so.
	 */
	minLength?: number;
	/**
	 * Vault name, which becomes this secret's readable placeholder.
	 *
	 * A named entry shows the model `#GITHUB_TOKEN#`, so with several secrets loaded it can
	 * choose the credential a command needs. Unnamed values use a machine-keyed HMAC token.
	 * Both forms are stable across restarts when production supplies the persisted vault key.
	 *
	 * `placeholder.ts` owns the structural separation: names start with a letter and opaque
	 * value-placeholder bodies start with the reserved digit `0`.
	 */
	name?: string;
	/**
	 * When this secret stops being substituted, in epoch milliseconds, or `null` for never.
	 *
	 * CARRIED IN HERE SO EXPIRY IS ENFORCED AT THE MOMENT OF USE. The vault prunes expired
	 * entries when it is read, which covers a session that starts after a lifetime lapsed and
	 * covers nothing else: a session already running holds its values in this object, so before
	 * this field a credential whose lifetime ended overnight kept being substituted into commands
	 * until somebody happened to run a `/secret` subcommand. The documentation said the opposite,
	 * and the reconcile that would have fixed it only ran after a command.
	 *
	 * Only vault entries carry one. Environment and `secrets.yml` entries have no lifetime, so
	 * they leave it `undefined`, which means the same as `null` here.
	 */
	expiresAt?: number | null;
}

/** How a caller hears about secrets the obfuscator could not protect. */
export interface SecretObfuscatorOptions {
	/**
	 * Called once for every rejection, at the moment it is decided.
	 *
	 * Take this rather than polling {@link SecretObfuscator.rejections} after construction.
	 * Some rejections are only discoverable while obfuscating (a pattern that over-matches
	 * shows up on the first message it touches, not at startup), so a caller that reads the
	 * array once has already missed them.
	 */
	onRejection?: (rejection: SecretRejection) => void;
	/**
	 * Called once per name when a lifetime lapses and the secret stops being substituted.
	 *
	 * A credential that silently stops working produces the most confusing possible failure: the
	 * agent's command runs with `#GITHUB_TOKEN#` in it verbatim, the API returns 401, and nothing
	 * anywhere says the lifetime ran out. This is the channel that makes the expiry loud (Law 10),
	 * and the caller wires it to an operator notice.
	 */
	onExpiry?: (name: string) => void;
	/**
	 * Clock, injected so an expiry test does not sleep.
	 *
	 * Defaults to `Date.now`. A test that had to wait a real second to prove a one-second lifetime
	 * would either be slow or be written against a lifetime nobody uses.
	 */
	now?: () => number;
	/**
	 * Machine-local HMAC key for stable unnamed placeholders.
	 *
	 * Production passes the persisted vault key. Direct SDK users that omit it receive a
	 * process-local key, which keeps tokens opaque and stable for that process.
	 */
	placeholderKey?: Uint8Array;
}

/**
 * JSON as it arrives from a caller's object, where an optional property is `undefined`.
 *
 * NAMED FOR WHAT MAKES IT DIFFERENT, because it used to be called `JsonValue` and it is
 * not the repository's `JsonValue` (`@veyyon/utils`): that one's objects hold `JsonValue`
 * and never `undefined`, since `undefined` is not JSON and `JSON.stringify` drops the
 * property rather than encoding it. Two exported types with one name and different
 * contents is a bug waiting for an editor's auto-import to pick the wrong one, and the
 * difference here is load-bearing rather than accidental: {@link mapJsonStrings} walks
 * tool-call arguments that came from a model, and a TypeScript object literal with
 * optional fields is not assignable to the strict shape, so the walker would refuse the
 * values it exists to rewrite.
 */
export type JsonWithOptionalFields =
	| string
	| number
	| boolean
	| null
	| JsonWithOptionalFields[]
	| { [key: string]: JsonWithOptionalFields | undefined };

/** An object of {@link JsonWithOptionalFields}, which is what a tool's arguments are. */
export type JsonRecord = { [key: string]: JsonWithOptionalFields | undefined };

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replacement generation
// ═══════════════════════════════════════════════════════════════════════════

const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PROCESS_PLACEHOLDER_KEY = crypto.randomBytes(32);

/** Maximum configured entries; high enough for generated enterprise registries, finite for hostile input. */
export const MAX_SECRET_ENTRIES = 10_000;
/** Maximum regex rules scanned over one string. Literal rules use a shared multi-pattern matcher. */
export const MAX_SECRET_REGEX_ENTRIES = 256;
/** Maximum UTF-8 bytes retained for one configured or discovered secret or alias. */
export const MAX_SECRET_VALUE_BYTES = 1024 * 1024;
/** Maximum UTF-8 bytes accepted or emitted by one text transformation. */
export const MAX_TRANSFORMED_TEXT_BYTES = 16 * 1024 * 1024;
/** Maximum regex/literal match events examined while transforming one string. */
export const MAX_SECRET_MATCHES_PER_TEXT = 20_000;
/** Maximum placeholder-shaped tokens examined while expanding one string. */
export const MAX_PLACEHOLDERS_PER_TEXT = 10_000;
/** Maximum distinct runtime regex values retained by one obfuscator. */
export const MAX_RUNTIME_SECRET_VALUES = 10_000;
/** Maximum cumulative UTF-8 bytes retained for runtime regex values. */
export const MAX_RUNTIME_SECRET_BYTES = 8 * 1024 * 1024;
/** Maximum cumulative configured source/replacement bytes retained by one obfuscator. */
export const MAX_CONFIGURED_SECRET_BYTES = 16 * 1024 * 1024;
/** Maximum container nesting accepted by the iterative JSON transformation walk. */
export const MAX_JSON_TRANSFORM_DEPTH = 128;
/** Maximum unique containers plus primitive positions visited by one JSON transformation. */
export const MAX_JSON_TRANSFORM_NODES = 100_000;
/** Maximum cumulative plain-object keys visited by one JSON transformation. */
export const MAX_JSON_TRANSFORM_KEYS = 100_000;
/** Maximum cumulative UTF-8 bytes in input or transformed JSON strings and keys. */
export const MAX_JSON_TRANSFORM_STRING_BYTES = 16 * 1024 * 1024;
/** Long aliases avoid trie-per-character overhead; their count and cumulative bytes stay bounded. */
const MAX_LONG_TERMINAL_ALIASES = 16;
const SHORT_ALIAS_TRIE_CODE_UNITS = 256;
const MAX_TERMINAL_ALIAS_BYTES = 16 * 1024 * 1024;

interface LiteralMatcherNode<T> {
	children: Map<string, number>;
	fail: number;
	outputLink: number;
	outputs: Array<{ literal: string; value: T }>;
}

/**
 * Aho-Corasick matcher shared by literal secrets and terminal aliases.
 *
 * Construction is linear in configured characters. Scanning is linear in input plus reported
 * matches, and callers cap match events before retaining replacement state.
 */
class LiteralMatcher<T> {
	readonly #nodes: Array<LiteralMatcherNode<T>> = [
		{ children: new Map(), fail: 0, outputLink: 0, outputs: [] },
	];
	readonly #longEntries: Array<{ literal: string; value: T }> = [];

	constructor(entries: Iterable<readonly [string, T]>) {
		for (const [literal, value] of entries) {
			if (literal.length === 0) continue;
			if (literal.length > SHORT_ALIAS_TRIE_CODE_UNITS) {
				if (this.#longEntries.length >= MAX_LONG_TERMINAL_ALIASES) {
					throw new Error("Refusing too many long literal secret rules.");
				}
				this.#longEntries.push({ literal, value });
				continue;
			}
			let nodeIndex = 0;
			for (let index = 0; index < literal.length; index++) {
				const character = literal[index];
				const existing = this.#nodes[nodeIndex].children.get(character);
				if (existing !== undefined) {
					nodeIndex = existing;
					continue;
				}
				const childIndex = this.#nodes.length;
				this.#nodes.push({ children: new Map(), fail: 0, outputLink: 0, outputs: [] });
				this.#nodes[nodeIndex].children.set(character, childIndex);
				nodeIndex = childIndex;
			}
			this.#nodes[nodeIndex].outputs.push({ literal, value });
		}
		this.#buildFailureLinks();
	}

	#buildFailureLinks(): void {
		const queue: number[] = [];
		for (const child of this.#nodes[0].children.values()) queue.push(child);
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const nodeIndex = queue[cursor];
			const node = this.#nodes[nodeIndex];
			for (const [character, childIndex] of node.children) {
				let failure = node.fail;
				while (failure !== 0 && !this.#nodes[failure].children.has(character)) {
					failure = this.#nodes[failure].fail;
				}
				const transition = this.#nodes[failure].children.get(character);
				if (transition !== undefined && transition !== childIndex) failure = transition;
				const child = this.#nodes[childIndex];
				child.fail = failure;
				child.outputLink =
					this.#nodes[failure].outputs.length > 0 ? failure : this.#nodes[failure].outputLink;
				queue.push(childIndex);
			}
		}
	}

	forEachMatch(
		text: string,
		visit: (start: number, end: number, value: T, literal: string) => boolean | void,
		maxMatches = MAX_SECRET_MATCHES_PER_TEXT,
	): void {
		let nodeIndex = 0;
		let matchCount = 0;
		for (let index = 0; index < text.length; index++) {
			const character = text[index];
			while (nodeIndex !== 0 && !this.#nodes[nodeIndex].children.has(character)) {
				nodeIndex = this.#nodes[nodeIndex].fail;
			}
			nodeIndex = this.#nodes[nodeIndex].children.get(character) ?? 0;
			let outputNode = nodeIndex;
			while (outputNode !== 0) {
				for (const output of this.#nodes[outputNode].outputs) {
					if (++matchCount > maxMatches) {
						throw new Error("Refusing a secret transformation with too many match events.");
					}
					if (visit(index + 1 - output.literal.length, index + 1, output.value, output.literal) === false) {
						return;
					}
				}
				outputNode = this.#nodes[outputNode].outputLink;
			}
		}
		for (const output of this.#longEntries) {
			for (
				let start = text.indexOf(output.literal);
				start >= 0;
				start = text.indexOf(output.literal, start + 1)
			) {
				if (++matchCount > maxMatches) {
					throw new Error("Refusing a secret transformation with too many match events.");
				}
				if (visit(start, start + output.literal.length, output.value, output.literal) === false) return;
			}
		}
	}

	hasMatch(text: string): boolean {
		let matched = false;
		this.forEachMatch(
			text,
			() => {
				matched = true;
				return false;
			},
			1,
		);
		return matched;
	}
}

function utf8ByteLengthInRange(value: string, start = 0, end = value.length): number {
	let bytes = 0;
	for (let index = start; index < end; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			bytes++;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < end) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function assertBoundedSecretString(value: string): void {
	if (!isWellFormedUtf16(value)) {
		throw new Error("Refusing ill-formed UTF-16 in secret transformation data.");
	}
	if (utf8ByteLengthInRange(value) > MAX_SECRET_VALUE_BYTES) {
		throw new Error("Refusing secret transformation data above the per-value byte limit.");
	}
}

function assertBoundedTransformText(value: string): number {
	const bytes = utf8ByteLengthInRange(value);
	if (bytes > MAX_TRANSFORMED_TEXT_BYTES) {
		throw new Error("Refusing a secret transformation above the text byte limit.");
	}
	return bytes;
}

/**
 * Generate a machine-keyed same-length replacement after hashing the source exactly once.
 *
 * The fixed-size keyed seed is expanded in counter mode. Runtime is O(source bytes + output bytes),
 * rather than re-interpolating and re-hashing the whole source for each output block.
 */
function generateDeterministicReplacement(
	secret: string,
	key: Uint8Array,
	forbidden: LiteralMatcher<true>,
): string {
	const seed = crypto
		.createHmac("sha256", key)
		.update("replacement-source\0", "utf8")
		.update(secret, "utf8")
		.digest();
	const counterBytes = Buffer.allocUnsafe(8);
	for (let attempt = 0; attempt < 256; attempt++) {
		const chunks: string[] = [];
		let outputLength = 0;
		for (let counter = 0; outputLength < secret.length; counter++) {
			counterBytes.writeUInt32BE(attempt, 0);
			counterBytes.writeUInt32BE(counter, 4);
			const digest = crypto
				.createHmac("sha256", key)
				.update("replacement-expand\0", "utf8")
				.update(seed)
				.update(counterBytes)
				.digest();
			let chunk = "";
			for (const byte of digest) {
				if (byte >= 248) continue;
				chunk += REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length];
				if (outputLength + chunk.length === secret.length) break;
			}
			chunks.push(chunk);
			outputLength += chunk.length;
		}
		const candidate = chunks.join("");
		if (candidate !== secret && !forbidden.hasMatch(candidate)) return candidate;
	}
	throw new Error("Could not generate a replacement distinct from configured secret sources.");
}

/** Refuse one-way replacement text that could later be expanded as a live credential. */
function assertOneWayReplacement(replacement: string): void {
	assertBoundedSecretString(replacement);
	PLACEHOLDER_RE.lastIndex = 0;
	for (;;) {
		const match = PLACEHOLDER_RE.exec(replacement);
		if (match === null) break;
		if (isSecretPlaceholder(match[0])) {
			PLACEHOLDER_RE.lastIndex = 0;
			throw new Error("Refusing a secret replacement that contains a reversible secret placeholder.");
		}
	}
	PLACEHOLDER_RE.lastIndex = 0;
}

/** Refuse a replacement that would put any configured exact secret source back on the wire. */
function resolveSafeReplacement(
	secret: string,
	preferred: string | undefined,
	forbidden: LiteralMatcher<true>,
	key: Uint8Array,
): string {
	if (preferred !== undefined) {
		assertOneWayReplacement(preferred);
		if (forbidden.hasMatch(preferred)) {
			throw new Error("Refusing a secret replacement that contains a configured secret.");
		}
		return preferred;
	}
	return generateDeterministicReplacement(secret, key, forbidden);
}

// ═══════════════════════════════════════════════════════════════════════════
// SecretObfuscator
// ═══════════════════════════════════════════════════════════════════════════

interface ProtectedSpan {
	start: number;
	end: number;
	/** Only a pre-existing terminal alias may be consumed as part of a larger exact literal source. */
	allowContainingLiteral?: boolean;
}

interface ProtectedText {
	text: string;
	spans: ProtectedSpan[];
}

interface TextReplacement extends ProtectedSpan {
	replacement: string;
}
interface LiteralRule {
	replacement: string;
}

interface CompiledRegexEntry {
	regex: RegExp;
	mode: "obfuscate" | "replace";
	replacement?: string;
	minLength: number;
	entryIndex: number;
	aliases: Map<string, string>;
}


export class SecretObfuscator {
	/** Reversible and retired plain secrets: secret → provider-safe placeholder. */
	#plainMappings = new Map<string, string>();

	/** Contextual regex matches: secret → placeholder, never applied outside a regex span. */
	#regexMappings = new Map<string, string>();

	/** Regex entries compiled once at construction. */
	#regexEntries: CompiledRegexEntry[] = [];

	/** Replace-mode plain mappings: secret → terminal one-way alias. */
	#replaceMappings = new Map<string, string>();

	/** Reverse lookup for deobfuscation: placeholder → secret. */
	#deobfuscateMap = new Map<string, string>();

	/** Every live placeholder for a value, used to select a survivor after one alias expires. */
	#placeholdersBySecret = new Map<string, Set<string>>();

	/** One-way outputs are terminal across calls, not only within the call that created them. */
	#terminalAliases = new Set<string>();
	#longTerminalAliases = new Set<string>();
	#terminalAliasBytes = 0;
	#aliasOrigins = new Map<string, Set<number>>();
	#aliasMatcher = new LiteralMatcher<true>([]);
	#aliasMatcherDirty = false;

	/** Literal sources share one compiled multi-pattern matcher. */
	#plainMatcher = new LiteralMatcher<LiteralRule>([]);
	#plainMatcherDirty = false;

	/** Configured exact sources used to prove replacement text cannot contain a secret. */
	#configuredForbiddenMatcher: LiteralMatcher<true>;

	/** HMAC key snapshot for unnamed placeholders and deterministic aliases. */
	#placeholderKey: Uint8Array;

	/** Values known to be sensitive, including bounded regex matches discovered at runtime. */
	#knownSecretValues = new Set<string>();
	#runtimeSecretCount = 0;
	#runtimeSecretBytes = 0;

	/** Whether any secrets were configured. */
	#hasAny: boolean;

	#rejections: SecretRejection[] = [];
	#reportedOvermatch = new Set<number>();
	#onRejection: ((rejection: SecretRejection) => void) | undefined;
	#onExpiry: ((name: string) => void) | undefined;
	#now: () => number;
	#expiryByPlaceholder = new Map<string, number>();
	#nextExpiryAt = Number.POSITIVE_INFINITY;

	/**
	 * Record a rejection and tell the caller in the same breath.
	 *
	 * THE ONLY PLACE A REJECTION IS CREATED, because the first version of this appended to
	 * an array that one startup loop read once, immediately after construction. Rejections
	 * raised later, during `obfuscate()`, were therefore recorded and never read by anyone:
	 * the array grew in silence, which is the exact failure this class was being fixed for.
	 * Notifying here means the moment of the decision and the moment it is surfaced cannot
	 * drift apart again.
	 */
	#reject(rejection: SecretRejection): void {
		this.#rejections.push(rejection);
		this.#onRejection?.(rejection);
	}
	#assertValidExpiry(expiresAt: number | null | undefined): void {
		if (expiresAt !== undefined && expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
			throw new Error("Refusing a secret expiry that is not a finite safe-integer epoch timestamp.");
		}
	}

	#registerAlias(alias: string, entryIndex: number): void {
		assertBoundedSecretString(alias);
		if (!this.#terminalAliases.has(alias)) {
			const bytes = utf8ByteLengthInRange(alias);
			if (this.#terminalAliasBytes + bytes > MAX_TERMINAL_ALIAS_BYTES) {
				throw new Error("Refusing one-way alias state above the cumulative byte limit.");
			}
			if (alias.length > SHORT_ALIAS_TRIE_CODE_UNITS) {
				if (this.#longTerminalAliases.size >= MAX_LONG_TERMINAL_ALIASES) {
					throw new Error("Refusing too many long one-way aliases.");
				}
				this.#longTerminalAliases.add(alias);
			}
			this.#terminalAliases.add(alias);
			this.#terminalAliasBytes += bytes;
			this.#aliasMatcherDirty = true;
		}
		let origins = this.#aliasOrigins.get(alias);
		if (origins === undefined) {
			origins = new Set();
			this.#aliasOrigins.set(alias, origins);
		}
		origins.add(entryIndex);
	}

	#assertNoCrossRuleAliasCapture(alias: string, origins: ReadonlySet<number>): void {
		for (const entry of this.#regexEntries) {
			if (origins.has(entry.entryIndex)) continue;
			entry.regex.lastIndex = 0;
			const captured = entry.regex.exec(alias) !== null;
			entry.regex.lastIndex = 0;
			if (captured) {
				throw new Error("Refusing a one-way alias captured by another secret rule.");
			}
		}
	}

	#rebuildPlainMatcher(): void {
		const rules: Array<readonly [string, LiteralRule]> = [];
		for (const [secret, replacement] of this.#plainMappings) rules.push([secret, { replacement }]);
		for (const [secret, replacement] of this.#replaceMappings) rules.push([secret, { replacement }]);
		this.#plainMatcher = new LiteralMatcher(rules);
		this.#plainMatcherDirty = false;
	}

	#ensurePlainMatcher(): void {
		if (this.#plainMatcherDirty) this.#rebuildPlainMatcher();
	}

	#ensureAliasMatcher(): void {
		if (!this.#aliasMatcherDirty) return;
		const shortAliases: Array<readonly [string, true]> = [];
		for (const alias of this.#terminalAliases) {
			if (alias.length <= SHORT_ALIAS_TRIE_CODE_UNITS) shortAliases.push([alias, true]);
		}
		this.#aliasMatcher = new LiteralMatcher(shortAliases);
		this.#aliasMatcherDirty = false;
	}

	#rememberRuntimeSecret(value: string): void {
		if (this.#knownSecretValues.has(value)) return;
		assertBoundedSecretString(value);
		const bytes = utf8ByteLengthInRange(value);
		if (
			this.#runtimeSecretCount + 1 > MAX_RUNTIME_SECRET_VALUES ||
			this.#runtimeSecretBytes + bytes > MAX_RUNTIME_SECRET_BYTES
		) {
			throw new Error("Refusing to retain regex secret state above the runtime limit.");
		}
		this.#knownSecretValues.add(value);
		this.#runtimeSecretCount++;
		this.#runtimeSecretBytes += bytes;
	}


	constructor(entries: SecretEntry[], options?: SecretObfuscatorOptions) {
		if (entries.length > MAX_SECRET_ENTRIES) {
			throw new Error("Refusing a secret registry above the configured entry limit.");
		}
		const suppliedKey = options?.placeholderKey ?? PROCESS_PLACEHOLDER_KEY;
		if (!(suppliedKey instanceof Uint8Array) || suppliedKey.byteLength !== 32) {
			throw new Error("Refusing a placeholder key that is not exactly 32 bytes.");
		}
		this.#placeholderKey = Uint8Array.from(suppliedKey);
		this.#onRejection = options?.onRejection;
		this.#onExpiry = options?.onExpiry;
		this.#now = options?.now ?? Date.now;

		const sourcePolicies = new Map<string, { mode: "obfuscate" | "replace"; replacement?: string }>();
		const configuredPlainSources: Array<readonly [string, true]> = [];
		let configuredBytes = 0;
		let regexEntryCount = 0;
		for (const entry of entries) {
			if (!isWellFormedUtf16(entry.content)) {
				throw new Error("Refusing ill-formed UTF-16 in secret transformation data.");
			}
			const contentBytes = utf8ByteLengthInRange(entry.content);
			if (contentBytes > MAX_SECRET_VALUE_BYTES) {
				throw new Error("Refusing secret transformation data above the per-value byte limit.");
			}
			configuredBytes += contentBytes;
			if (entry.replacement !== undefined) {
				assertOneWayReplacement(entry.replacement);
				configuredBytes += utf8ByteLengthInRange(entry.replacement);
			}
			if (configuredBytes > MAX_CONFIGURED_SECRET_BYTES) {
				throw new Error("Refusing a secret registry above the cumulative byte limit.");
			}
			this.#assertValidExpiry(entry.expiresAt);
			const mode = entry.mode ?? "obfuscate";
			const sourceKey = `${entry.type}\0${entry.content}`;
			const existingPolicy = sourcePolicies.get(sourceKey);
			if (
				existingPolicy !== undefined &&
				(existingPolicy.mode !== mode ||
					(mode === "replace" && existingPolicy.replacement !== entry.replacement))
			) {
				throw new Error("Refusing conflicting policies for the same exact secret source.");
			}
			sourcePolicies.set(sourceKey, { mode, replacement: entry.replacement });
			if (entry.type === "plain") configuredPlainSources.push([entry.content, true]);
			else if (++regexEntryCount > MAX_SECRET_REGEX_ENTRIES) {
				throw new Error("Refusing a secret registry above the regex entry limit.");
			}
		}
		this.#configuredForbiddenMatcher = new LiteralMatcher(configuredPlainSources);
		for (const entry of entries) {
			if (
				(entry.mode ?? "obfuscate") === "replace" &&
				entry.replacement !== undefined &&
				this.#configuredForbiddenMatcher.hasMatch(entry.replacement)
			) {
				throw new Error("Refusing a secret replacement that contains a configured secret.");
			}
		}

		let hasRealSecret = false;
		for (const [entryIndex, entry] of entries.entries()) {
			const mode = entry.mode ?? "obfuscate";
			if (entry.type === "plain" && mode === "replace" && entry.content.length === 0) {
				throw new Error("Refusing an empty plain secret, which cannot protect or replace any bytes.");
			}
			if (entry.type === "plain") {
				if (mode === "obfuscate") {
					if (!canObfuscatePlainValue(entry.content)) {
						this.#reject({
							reason: "too-short-to-obfuscate",
							index: entryIndex,
							length: secretCharacterLength(entry.content),
						});
						continue;
					}
					if (entry.name !== undefined && !isValidSecretName(entry.name)) {
						throw new Error("Refusing an invalid secret name in a reversible placeholder.");
					}
					const placeholder =
						entry.name === undefined
							? this.#buildValuePlaceholder(entry.content)
							: buildNamePlaceholder(entry.name);
					this.#registerReversible(entry.content, placeholder, entry.expiresAt);
				} else {
					const alias = resolveSafeReplacement(
						entry.content,
						entry.replacement,
						this.#configuredForbiddenMatcher,
						this.#placeholderKey,
					);
					this.#replaceMappings.set(entry.content, alias);
					this.#knownSecretValues.add(entry.content);
					this.#registerAlias(alias, entryIndex);
				}
				hasRealSecret = true;
				continue;
			}

			try {
				const regex = compileSecretRegex(entry.content, entry.flags);
				let replacement = entry.replacement;
				if (mode === "replace" && replacement !== undefined) {
					if (this.#configuredForbiddenMatcher.hasMatch(replacement)) {
						throw new Error("replacement contains a configured exact secret source");
					}
					this.#registerAlias(replacement, entryIndex);
				}
				this.#regexEntries.push({
					regex,
					mode,
					replacement,
					minLength: entry.minLength ?? MIN_OBFUSCATABLE_LENGTH,
					entryIndex,
					aliases: new Map(),
				});
				hasRealSecret = true;
			} catch (error) {
				this.#reject({
					reason: "invalid-pattern",
					index: entryIndex,
					length: entry.content.length,
					detail: errorMessage(error),
				});
			}
		}

		for (const [alias, origins] of this.#aliasOrigins) this.#assertNoCrossRuleAliasCapture(alias, origins);
		this.#rebuildPlainMatcher();
		this.#hasAny = hasRealSecret;
	}

	/** Build an unnamed placeholder and fail closed on the retained-HMAC collision case. */
	#buildValuePlaceholder(secret: string): string {
		const placeholder = buildValuePlaceholder(secret, this.#placeholderKey);
		const existing = this.#deobfuscateMap.get(placeholder);
		if (existing !== undefined && existing !== secret) {
			throw new Error("Refusing to register two secrets with the same opaque placeholder.");
		}
		return placeholder;
	}

	/** Install one reversible mapping, retaining every live alias for duplicate values. */
	#registerReversible(secret: string, placeholder: string, expiresAt?: number | null): void {
		assertBoundedSecretString(secret);
		this.#assertValidExpiry(expiresAt);
		const existing = this.#deobfuscateMap.get(placeholder);
		if (existing !== undefined && existing !== secret) this.#forgetPlaceholder(placeholder);
		this.#knownSecretValues.add(secret);
		this.#plainMappings.set(secret, placeholder);
		this.#deobfuscateMap.set(placeholder, secret);
		let placeholders = this.#placeholdersBySecret.get(secret);
		if (placeholders === undefined) {
			placeholders = new Set();
			this.#placeholdersBySecret.set(secret, placeholders);
		}
		placeholders.add(placeholder);
		this.#plainMatcherDirty = true;
		this.#trackExpiry(placeholder, expiresAt);
	}

	hasSecrets(): boolean {
		return this.#hasAny;
	}

	/**
	 * Carry forward only the previous obfuscator's redaction knowledge.
	 *
	 * Expansion rights are deliberately not copied. Call this only when refreshing the same
	 * workspace scope. A removed or expired value remains hidden, while its old readable
	 * placeholder cannot spend it.
	 */
	retainRedactionsFrom(previous: SecretObfuscator): void {
		for (const value of previous.#knownSecretValues) {
			if (this.#plainMappings.has(value)) continue;
			this.#knownSecretValues.add(value);
			this.#plainMappings.set(value, this.#buildValuePlaceholder(value));
			this.#hasAny = true;
		}
		this.#plainMatcherDirty = true;
	}

	/**
	 * Start protecting one more named secret, mid-session.
	 *
	 * A rotation retires the old value to its opaque value placeholder before the name is
	 * rebound. Historical occurrences therefore stay redacted without expanding to the new
	 * credential. Returns the readable placeholder the model should use.
	 */
	addNamedSecret(name: string, value: string, expiresAt?: number | null): string {
		assertBoundedSecretString(value);
		this.#assertValidExpiry(expiresAt);
		if (!canObfuscatePlainValue(value)) {
			throw new Error(
				`Refusing to add ${name}: the value is ${secretCharacterLength(value)} characters, under the ` +
					`${MIN_OBFUSCATABLE_LENGTH}-character minimum for a reversible placeholder.`,
			);
		}

		if (!isValidSecretName(name)) {
			throw new Error("Refusing an invalid secret name in a reversible placeholder.");
		}
		const placeholder = buildNamePlaceholder(name);
		const existing = this.#deobfuscateMap.get(placeholder);
		if (existing === value) {
			this.#trackExpiry(placeholder, expiresAt);
			return placeholder;
		}
		if (existing !== undefined) this.#forgetPlaceholder(placeholder);
		this.#registerReversible(value, placeholder, expiresAt);
		this.#hasAny = true;
		return placeholder;
	}

	/**
	 * Record, refresh, or clear one placeholder's deadline.
	 *
	 * `undefined` and `null` both mean "does not expire", so an environment or `secrets.yml` entry
	 * needs no special case at the call sites. An entry that used to expire and no longer does has
	 * its deadline REMOVED rather than left behind, or `/secret extend NAME --ttl never` would keep
	 * the old deadline and drop the secret at it.
	 */
	#trackExpiry(placeholder: string, expiresAt: number | null | undefined): void {
		this.#assertValidExpiry(expiresAt);
		const previous = this.#expiryByPlaceholder.get(placeholder);
		if (expiresAt === undefined || expiresAt === null) {
			this.#expiryByPlaceholder.delete(placeholder);
			if (previous === this.#nextExpiryAt) this.#recomputeNextExpiry();
			return;
		}
		this.#expiryByPlaceholder.set(placeholder, expiresAt);
		if (expiresAt < this.#nextExpiryAt) {
			this.#nextExpiryAt = expiresAt;
		} else if (previous === this.#nextExpiryAt && expiresAt > previous) {
			this.#recomputeNextExpiry();
		}
	}

	/** Refresh the cached soonest deadline. Called whenever the expiry map changes, never per use. */
	#recomputeNextExpiry(): void {
		let soonest = Number.POSITIVE_INFINITY;
		for (const at of this.#expiryByPlaceholder.values()) {
			if (at < soonest) soonest = at;
		}
		this.#nextExpiryAt = soonest;
	}

	/**
	 * Stop substituting anything whose lifetime has run out.
	 *
	 * THE POINT OF THIS METHOD, and it is a security property rather than housekeeping. Expiry
	 * means the value is no longer used, not that it is no longer hidden, and a long-running
	 * session used to enforce that only when it happened to reload the vault. A session left open
	 * over a weekend went on spending a one-day credential.
	 *
	 * It returns early on one number comparison, so the check is free on the calls where nothing
	 * has expired, which is all of them but one per lifetime.
	 */
	#forgetExpired(): void {
		if (this.#nextExpiryAt === Number.POSITIVE_INFINITY) return;
		const now = this.#now();
		if (!Number.isFinite(now)) throw new Error("Refusing to evaluate expiry with an invalid clock value.");
		if (now < this.#nextExpiryAt) return;

		for (const [placeholder, at] of this.#expiryByPlaceholder) {
			if (at > now) continue;
			this.#forgetPlaceholder(placeholder, false);
			this.#onExpiry?.(placeholder.slice(1, -1));
		}
		this.#recomputeNextExpiry();
	}

	/**
	 * Revoke one placeholder's expansion while retaining a forward redaction tombstone.
	 *
	 * Expiry and removal mean "do not spend this value", never "send the value to the
	 * provider". A named value moves to its opaque HMAC placeholder before the readable name
	 * can be rebound, so historical old values cannot expand to a newly rotated credential.
	 */
	forgetNamedSecret(name: string): void {
		this.#forgetPlaceholder(buildNamePlaceholder(name));
	}

	#forgetPlaceholder(placeholder: string, recomputeExpiry = true): void {
		const value = this.#deobfuscateMap.get(placeholder);
		if (value === undefined) return;
		this.#deobfuscateMap.delete(placeholder);
		const removedExpiry = this.#expiryByPlaceholder.get(placeholder);
		this.#expiryByPlaceholder.delete(placeholder);
		if (recomputeExpiry && removedExpiry === this.#nextExpiryAt) this.#recomputeNextExpiry();

		const placeholders = this.#placeholdersBySecret.get(value);
		placeholders?.delete(placeholder);
		if (placeholders?.size === 0) this.#placeholdersBySecret.delete(value);
		if (this.#plainMappings.get(value) === placeholder) {
			const survivor = placeholders?.values().next().value as string | undefined;
			this.#plainMappings.set(value, survivor ?? this.#buildValuePlaceholder(value));
			this.#plainMatcherDirty = true;
		}
	}

	/** Whether this obfuscator currently protects a secret under that name. */
	hasNamedSecret(name: string): boolean {
		this.#forgetExpired();
		return this.#deobfuscateMap.has(buildNamePlaceholder(name));
	}

	/**
	 * Whether this placeholder is one this obfuscator would substitute a value for.
	 *
	 * Asked by the audit log, which reads the model's arguments BEFORE expansion and has to tell
	 * a real placeholder from a `#HELLO#` somebody typed. Recording the second as a spent
	 * credential would make the log unreadable, and recording nothing at all would make it a lie.
	 * Both forms answer here, because both forms are substituted from the same map.
	 */
	knowsPlaceholder(placeholder: string): boolean {
		// Checked here too, so the audit log cannot record an expansion the substitution refused. A
		// log that says a credential was spent when it was not is worse than no log.
		this.#forgetExpired();
		return this.#deobfuscateMap.has(placeholder);
	}

	/**
	 * Names of every secret currently protected under a name placeholder.
	 *
	 * Exists so a caller can reconcile against the vault: whatever is here and no longer live
	 * has to be forgotten, or an expired credential would keep being substituted into commands
	 * for the rest of the session. Index-form secrets are not listed, because they have no name
	 * to reconcile against.
	 */
	namedSecretNames(): string[] {
		this.#forgetExpired();
		const names: string[] = [];
		for (const placeholder of this.#deobfuscateMap.keys()) {
			const body = placeholder.slice(1, -1);
			if (isValidSecretName(body)) names.push(body);
		}
		return names;
	}

	/**
	 * Declared secrets this obfuscator refused, in input order.
	 *
	 * Read this after construction and tell the operator. An empty array is the only
	 * state in which every declared secret is actually being protected.
	 */
	rejections(): readonly SecretRejection[] {
		return this.#rejections;
	}

	/** Obfuscate all secrets in text. Reversible values get placeholders; replace mode stays one-way. */
	obfuscate(text: string): string {
		if (!this.#hasAny) return text;
		assertBoundedTransformText(text);
		this.#forgetExpired();
		let state: ProtectedText = { text, spans: this.#protectedOutputSpans(text) };
		state = this.#applyPlainRules(state);
		let matchEvents = 0;

		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const replacements: TextReplacement[] = [];
			let protectedIndex = 0;
			for (;;) {
				const match = entry.regex.exec(state.text);
				if (match === null) break;
				if (++matchEvents > MAX_SECRET_MATCHES_PER_TEXT) {
					entry.regex.lastIndex = 0;
					throw new Error("Refusing a secret transformation with too many regex matches.");
				}
				const matchValue = match[0];
				if (matchValue.length === 0) {
					if (!this.#reportedOvermatch.has(entry.entryIndex)) {
						this.#reportedOvermatch.add(entry.entryIndex);
						this.#reject({
							reason: "too-short-to-obfuscate",
							index: entry.entryIndex,
							length: 0,
							detail: "pattern produced an empty match and therefore cannot protect any bytes.",
						});
					}
					entry.regex.lastIndex++;
					continue;
				}

				const matchEnd = match.index + matchValue.length;
				while (protectedIndex < state.spans.length && state.spans[protectedIndex].end <= match.index) {
					protectedIndex++;
				}
				const protectedSpan = state.spans[protectedIndex];
				if (protectedSpan !== undefined && protectedSpan.start < matchEnd) continue;

				assertBoundedSecretString(matchValue);
				const characterLength = secretCharacterLength(matchValue);
				if (entry.mode === "obfuscate" && characterLength < entry.minLength) {
					if (!this.#reportedOvermatch.has(entry.entryIndex)) {
						this.#reportedOvermatch.add(entry.entryIndex);
						this.#reject({
							reason: "too-short-to-obfuscate",
							index: entry.entryIndex,
							length: characterLength,
							detail:
								`pattern matched a ${characterLength}-character value, under this entry's ` +
								`${entry.minLength}-character floor. Set "minLength" on the entry if short ` +
								"matches are real secrets, or tighten the pattern.",
						});
					}
					continue;
				}

				this.#rememberRuntimeSecret(matchValue);
				let replacement: string;
				if (entry.mode === "replace") {
					if (entry.replacement !== undefined) {
						replacement = entry.replacement;
					} else {
						const cached = entry.aliases.get(matchValue);
						if (cached !== undefined) {
							replacement = cached;
						} else {
							replacement = generateDeterministicReplacement(
								matchValue,
								this.#placeholderKey,
								this.#configuredForbiddenMatcher,
							);
							if (this.#knownSecretValues.has(replacement)) {
								throw new Error("Could not generate an unambiguous one-way replacement.");
							}
							const origins = new Set([entry.entryIndex]);
							this.#assertNoCrossRuleAliasCapture(replacement, origins);
							this.#registerAlias(replacement, entry.entryIndex);
							entry.aliases.set(matchValue, replacement);
						}
					}
				} else {
					replacement =
						this.#regexMappings.get(matchValue) ??
						this.#plainMappings.get(matchValue) ??
						this.#buildValuePlaceholder(matchValue);
					if (!this.#deobfuscateMap.has(replacement)) {
						this.#regexMappings.set(matchValue, replacement);
						this.#deobfuscateMap.set(replacement, matchValue);
					}
				}
				replacements.push({ start: match.index, end: matchEnd, replacement });
			}
			entry.regex.lastIndex = 0;

			if (replacements.length > 0) state = this.#applyProtectedReplacements(state, replacements);
		}

		return this.#applyPlainRules(state).text;
	}

	/** Locate already-emitted placeholders and one-way aliases before any source rule runs. */
	#protectedOutputSpans(text: string): ProtectedSpan[] {
		const spans: ProtectedSpan[] = [];
		if (text.includes("#")) {
			const placeholders = new Set(this.#deobfuscateMap.keys());
			for (const placeholder of this.#plainMappings.values()) placeholders.add(placeholder);
			let placeholderCount = 0;
			PLACEHOLDER_RE.lastIndex = 0;
			for (;;) {
				const match = PLACEHOLDER_RE.exec(text);
				if (match === null) break;
				if (++placeholderCount > MAX_PLACEHOLDERS_PER_TEXT) {
					PLACEHOLDER_RE.lastIndex = 0;
					throw new Error("Refusing a secret transformation with too many placeholders.");
				}
				if (placeholders.has(match[0])) spans.push({ start: match.index, end: match.index + match[0].length });
			}
			PLACEHOLDER_RE.lastIndex = 0;
		}

		this.#ensureAliasMatcher();
		this.#aliasMatcher.forEachMatch(text, (start, end) => {
			spans.push({ start, end, allowContainingLiteral: true });
		});
		for (const alias of this.#longTerminalAliases) {
			for (let start = text.indexOf(alias); start >= 0; start = text.indexOf(alias, start + 1)) {
				if (spans.length >= MAX_SECRET_MATCHES_PER_TEXT) {
					throw new Error("Refusing a secret transformation with too many terminal aliases.");
				}
				spans.push({ start, end: start + alias.length, allowContainingLiteral: true });
			}
		}
		if (spans.length < 2) return spans;
		spans.sort((left, right) => left.start - right.start || right.end - left.end);
		const merged: ProtectedSpan[] = [];
		for (const span of spans) {
			const previous = merged[merged.length - 1];
			if (previous !== undefined && span.start < previous.end) {
				previous.allowContainingLiteral &&= span.allowContainingLiteral === true;
				if (span.end > previous.end) previous.end = span.end;
			} else {
				merged.push({ ...span });
			}
		}
		return merged;
	}

	/** Apply non-overlapping replacements while carrying protected output spans forward. */
	#applyProtectedReplacements(state: ProtectedText, replacements: readonly TextReplacement[]): ProtectedText {
		let outputBytes = utf8ByteLengthInRange(state.text);
		for (const replacement of replacements) {
			outputBytes +=
				utf8ByteLengthInRange(replacement.replacement) -
				utf8ByteLengthInRange(state.text, replacement.start, replacement.end);
			if (outputBytes > MAX_TRANSFORMED_TEXT_BYTES) {
				throw new Error("Refusing a secret transformation above the output byte limit.");
			}
		}

		const chunks: string[] = [];
		const spans: ProtectedSpan[] = [];
		let outputLength = 0;
		let cursor = 0;
		let spanIndex = 0;
		let replacementIndex = 0;
		const append = (part: string): void => {
			chunks.push(part);
			outputLength += part.length;
		};

		while (spanIndex < state.spans.length || replacementIndex < replacements.length) {
			const span = state.spans[spanIndex];
			const replacement = replacements[replacementIndex];
			const useSpan = replacement === undefined || (span !== undefined && span.start <= replacement.start);
			const event = useSpan ? span : replacement;
			if (event === undefined) break;
			append(state.text.slice(cursor, event.start));
			const protectedStart = outputLength;
			if (useSpan) {
				append(state.text.slice(event.start, event.end));
				spanIndex++;
			} else {
				append(replacement.replacement);
				replacementIndex++;
			}
			if (outputLength > protectedStart) {
				spans.push({
					start: protectedStart,
					end: outputLength,
					allowContainingLiteral: useSpan ? span.allowContainingLiteral : false,
				});
			}
			cursor = event.end;
		}
		append(state.text.slice(cursor));
		return { text: chunks.join(""), spans };
	}

	/**
	 * Apply every literal rule against the same input view.
	 *
	 * One-pass selection prevents a replacement from being reinterpreted as another secret.
	 * At a shared position the longest value wins. Cached next positions make each rule scan the
	 * input monotonically instead of rescanning the remaining suffix after every match.
	 */
	#applyPlainRules(state: ProtectedText): ProtectedText {
		this.#ensurePlainMatcher();
		const bestByStart = new Map<number, TextReplacement>();
		this.#plainMatcher.forEachMatch(state.text, (start, end, rule) => {
			const existing = bestByStart.get(start);
			if (existing === undefined || end - start > existing.end - existing.start) {
				bestByStart.set(start, { start, end, replacement: rule.replacement });
			}
		});
		if (bestByStart.size === 0) return state;

		const candidates = [...bestByStart.values()].sort(
			(left, right) => left.start - right.start || right.end - left.end,
		);
		const replacements: TextReplacement[] = [];
		let cursor = 0;
		let spanIndex = 0;
		for (const candidate of candidates) {
			if (candidate.start < cursor) continue;
			while (spanIndex < state.spans.length && state.spans[spanIndex].end <= candidate.start) spanIndex++;
			let blocked = false;
			for (let check = spanIndex; check < state.spans.length && state.spans[check].start < candidate.end; check++) {
				const span = state.spans[check];
				if (
					span.allowContainingLiteral !== true ||
					candidate.start > span.start ||
					candidate.end < span.end
				) {
					blocked = true;
					break;
				}
			}
			if (blocked) continue;
			replacements.push(candidate);
			cursor = candidate.end;
		}
		return replacements.length === 0 ? state : this.#applyProtectedReplacements(state, replacements);
	}

	/** Deobfuscate live reversible placeholders. Retired and expired placeholders stay opaque. */
	deobfuscate(text: string): string {
		if (!this.#hasAny || !text.includes("#")) return text;
		const inputBytes = assertBoundedTransformText(text);
		this.#forgetExpired();
		let outputBytes = inputBytes;
		let placeholderCount = 0;
		PLACEHOLDER_RE.lastIndex = 0;
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (++placeholderCount > MAX_PLACEHOLDERS_PER_TEXT) {
				PLACEHOLDER_RE.lastIndex = 0;
				throw new Error("Refusing a secret expansion with too many placeholders.");
			}
			const secret = this.#deobfuscateMap.get(match[0]);
			if (secret === undefined) continue;
			outputBytes += utf8ByteLengthInRange(secret) - utf8ByteLengthInRange(match[0]);
			if (outputBytes > MAX_TRANSFORMED_TEXT_BYTES) {
				PLACEHOLDER_RE.lastIndex = 0;
				throw new Error("Refusing a secret expansion above the output byte limit.");
			}
		}
		PLACEHOLDER_RE.lastIndex = 0;
		return text.replace(PLACEHOLDER_RE, match => this.#deobfuscateMap.get(match) ?? match);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Display restore (inbound, persisted/provider → local display)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Restore secret placeholders for local display. Only message kinds the model
 * itself authored from obfuscated context carry placeholders, and assistant
 * content and the LLM-written branch/compaction summaries. User, developer, and
 * tool-result messages are persisted with their literal text, so a literal
 * `#ABCD#` the operator typed must survive untouched; those roles are never
 * walked.
 */
export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	const messages = deobfuscateAgentMessages(obfuscator, sessionContext.messages);
	return messages === sessionContext.messages ? sessionContext : { ...sessionContext, messages };
}

export function deobfuscateAgentMessages(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	return mapAgentMessageStrings(messages, s => obfuscator.deobfuscate(s));
}

/**
 * Map every model-authored string in a persisted transcript through `fn`:
 * assistant content, and the LLM-written branch/compaction summaries (and their
 * text blocks). User, developer, and tool-result messages are persisted with
 * literal text and are never walked, so an operator's literal `#ABCD#` survives.
 * Shared by the secret codec (deobfuscation for display) and the argot expander
 * so both walk the transcript shape exactly one way.
 */
export function mapAgentMessageStrings(
	messages: AgentMessage[],
	fn: (s: string) => string,
	options?: ContentWalkOptions,
): AgentMessage[] {
	let changed = false;
	const result = messages.map((message): AgentMessage => {
		switch (message.role) {
			case "assistant": {
				const content = mapAssistantContentStrings(message.content, fn, options);
				if (content === message.content) return message;
				changed = true;
				return { ...message, content };
			}
			case "branchSummary": {
				const summary = fn(message.summary);
				if (summary === message.summary) return message;
				changed = true;
				return { ...message, summary };
			}
			case "compactionSummary": {
				const summary = fn(message.summary);
				const shortSummary = message.shortSummary === undefined ? undefined : fn(message.shortSummary);
				const blocks = message.blocks === undefined ? undefined : mapTextBlockStrings(message.blocks, fn);
				if (summary === message.summary && shortSummary === message.shortSummary && blocks === message.blocks) {
					return message;
				}
				changed = true;
				return { ...message, summary, shortSummary, blocks };
			}
			default:
				return message;
		}
	});
	return changed ? result : messages;
}

/**
 * Restore placeholders in assistant content: visible text and tool-call
 * arguments/intent/rawBlock. Thinking and signatures are opaque
 * provider-replay/hidden-reasoning data and pass through byte-identical.
 */
export function deobfuscateAssistantContent(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!obfuscator.hasSecrets()) return content;
	return mapAssistantContentStrings(content, s => obfuscator.deobfuscate(s), { includeToolMetadata: true });
}

/**
 * Whether a walk may rewrite thinking text.
 *
 * Off by default, and the default is the safe one. A thinking block is replayed
 * to the provider with its `thinkingSignature`, which is bound to the exact
 * bytes, so a walk whose output can find its way back into a request must leave
 * thinking untouched or the next call is rejected. Resume does exactly that: it
 * deobfuscates the persisted transcript and feeds it back as the starting
 * messages.
 *
 * Turn it on only for a copy that is rendered and then discarded. The argot
 * display seams do, because a person reading a model's reasoning has to see
 * `src/db.ts` where the model wrote `§db`, the same as in its prose.
 */
export interface ContentWalkOptions {
	readonly includeThinking?: boolean;
	readonly includeToolMetadata?: boolean;
}

/**
 * Map every model-authored string in assistant content through `fn`: visible
 * text and tool-call arguments/intent/rawBlock, plus thinking when
 * {@link ContentWalkOptions.includeThinking} is set. Signatures are opaque
 * provider-replay data and always pass through byte-identical. Shared by the
 * secret codec (deobfuscation) and the argot expander so both walk the
 * assistant-content shape exactly one way.
 */
export function mapAssistantContentStrings(
	content: AssistantMessage["content"],
	fn: (s: string) => string,
	options?: ContentWalkOptions,
): AssistantMessage["content"] {
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = fn(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking" && options?.includeThinking) {
			const thinking = fn(block.thinking);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking };
		}
		if (block.type === "toolCall") {
			const args = mapJsonStrings(block.arguments as JsonWithOptionalFields, fn) as Record<string, unknown>;
			const id = options?.includeToolMetadata ? fn(block.id) : block.id;
			const name = options?.includeToolMetadata ? fn(block.name) : block.name;
			const customWireName =
				options?.includeToolMetadata && block.customWireName !== undefined
					? fn(block.customWireName)
					: block.customWireName;
			const intent = block.intent === undefined ? undefined : fn(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : fn(block.rawBlock);
			if (
				args === block.arguments &&
				id === block.id &&
				name === block.name &&
				customWireName === block.customWireName &&
				intent === block.intent &&
				rawBlock === block.rawBlock
			) {
				return block;
			}
			changed = true;
			return { ...block, arguments: args, id, name, customWireName, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

/**
 * Restore placeholders inside a tool call's arguments. Arguments are arbitrary
 * model-authored JSON, so tool-call arguments are the ONLY place a recursive
 * JSON walk runs.
 */
export function deobfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	return mapJsonStrings(args as JsonWithOptionalFields, s => obfuscator.deobfuscate(s)) as Record<string, unknown>;
}

/** Redact secrets inside a tool call's arguments (same JSON-walk exception as {@link deobfuscateToolArguments}). */
export function obfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	return mapJsonStrings(args as JsonWithOptionalFields, s => obfuscator.obfuscate(s)) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Outbound obfuscation (local → provider)
// ═══════════════════════════════════════════════════════════════════════════

/** Fail closed rather than modifying authenticated provider replay metadata or sending a secret in it. */
function assertOpaqueProviderFieldSafe(
	obfuscator: SecretObfuscator,
	value: string | undefined,
	field: string,
): void {
	if (value !== undefined && obfuscator.obfuscate(value) !== value) {
		throw new Error(
			`Refusing to send provider context because opaque ${field} metadata contains a configured secret.`,
		);
	}
}

/** Native replay payloads may contain authenticated or encrypted strings, so they are validation-only. */
function assertOpaqueProviderPayloadSafe(
	obfuscator: SecretObfuscator,
	payload: unknown,
): void {
	if (mapJsonStrings(payload, text => obfuscator.obfuscate(text)) !== payload) {
		throw new Error(
			"Refusing to send provider context because opaque native replay metadata contains a configured secret.",
		);
	}
}

/** Obfuscate user/developer/tool-result blocks and validate opaque text signatures. */
function obfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		assertOpaqueProviderFieldSafe(obfuscator, block.textSignature, "text-signature");
		const text = obfuscator.obfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/** Obfuscate assistant replay fields while preserving authenticated bytes exactly. */
function obfuscateAssistantContentForProvider(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			assertOpaqueProviderFieldSafe(obfuscator, block.textSignature, "text-signature");
			const text = obfuscator.obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			assertOpaqueProviderFieldSafe(obfuscator, block.thinkingSignature, "thinking-signature");
			assertOpaqueProviderFieldSafe(obfuscator, block.itemId, "thinking-item");
			const thinking = obfuscator.obfuscate(block.thinking);
			if (thinking === block.thinking) return block;
			if (block.thinkingSignature !== undefined || block.itemId !== undefined) {
				throw new Error(
					"Refusing to send provider context because signed thinking contains a configured secret.",
				);
			}
			changed = true;
			return { ...block, thinking };
		}
		if (block.type === "redactedThinking") {
			assertOpaqueProviderFieldSafe(obfuscator, block.data, "redacted-thinking");
			return block;
		}
		if (block.type === "fallback") {
			const from = obfuscator.obfuscate(block.from.model);
			const to = obfuscator.obfuscate(block.to.model);
			if (from === block.from.model && to === block.to.model) return block;
			changed = true;
			return { ...block, from: { model: from }, to: { model: to } };
		}
		assertOpaqueProviderFieldSafe(obfuscator, block.thoughtSignature, "tool-thought-signature");
		const [mapped] = mapAssistantContentStrings([block], text => obfuscator.obfuscate(text), {
			includeToolMetadata: true,
		});
		if (mapped === block) return block;
		changed = true;
		return mapped;
	});
	return changed ? result : content;
}

/** Map `text` blocks through `fn`; image and other blocks pass through byte-identical. */
export function mapTextBlockStrings(
	content: (TextContent | ImageContent)[],
	fn: (s: string) => string,
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = fn(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/**
 * Redact every mutable string field that can reach a provider request.
 *
 * Authenticated signatures are never rewritten. If one itself contains a configured secret, or
 * signed thinking would need rewriting, dispatch fails closed with a credential-free error.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	if (!obfuscator.hasSecrets()) return messages;
	let changed = false;
	const result = messages.map((message): Message => {
		if (message.role === "assistant") {
			const content = obfuscateAssistantContentForProvider(obfuscator, message.content);
			if (message.providerPayload !== undefined) {
				assertOpaqueProviderPayloadSafe(obfuscator, message.providerPayload);
			}
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}

		if (message.role === "toolResult") {
			const content = obfuscateTextBlocks(obfuscator, message.content);
			const toolCallId = obfuscator.obfuscate(message.toolCallId);
			const toolName = obfuscator.obfuscate(message.toolName);
			if (
				content === message.content &&
				toolCallId === message.toolCallId &&
				toolName === message.toolName
			) {
				return message;
			}
			changed = true;
			return { ...message, content, toolCallId, toolName };
		}

		const content =
			typeof message.content === "string"
				? obfuscator.obfuscate(message.content)
				: obfuscateTextBlocks(obfuscator, message.content);
		if (content === message.content) return message;
		changed = true;
		return { ...message, content } as Message;
	});
	return changed ? result : messages;
}

function obfuscateToolDefinition(obfuscator: SecretObfuscator, tool: Tool): Tool {
	const name = obfuscator.obfuscate(tool.name);
	const description = obfuscator.obfuscate(tool.description);
	const parameters = mapJsonStrings(toolWireSchema(tool), text => obfuscator.obfuscate(text)) as Tool["parameters"];
	let customFormat = tool.customFormat;
	if (customFormat !== undefined) {
		const definition = obfuscator.obfuscate(customFormat.definition);
		if (definition !== customFormat.definition) customFormat = { ...customFormat, definition };
	}
	const customWireName = tool.customWireName === undefined ? undefined : obfuscator.obfuscate(tool.customWireName);
	const examples =
		tool.examples === undefined ? undefined : mapJsonStrings(tool.examples, text => obfuscator.obfuscate(text));
	if (
		name === tool.name &&
		description === tool.description &&
		parameters === tool.parameters &&
		customFormat === tool.customFormat &&
		customWireName === tool.customWireName &&
		examples === tool.examples
	) {
		return tool;
	}
	return { ...tool, name, description, parameters, customFormat, customWireName, examples };
}

/** Redact every provider-bound context surface, including prompts and tool schemas. */
export function obfuscateProviderContext(obfuscator: SecretObfuscator | undefined, context: Context): Context {
	if (!obfuscator?.hasSecrets()) return context;
	const systemPrompt = context.systemPrompt?.map(text => obfuscator.obfuscate(text));
	const messages = obfuscateMessages(obfuscator, context.messages);
	const tools = context.tools?.map(tool => obfuscateToolDefinition(obfuscator, tool));
	return { ...context, systemPrompt, messages, tools };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

interface JsonWalkFrame {
	original: unknown[] | Record<string, unknown>;
	kind: "array" | "object";
	keys: string[];
	sourceValues: unknown[];
	mappedKeys: string[];
	mappedValues: unknown[];
	prototype: object | null;
	target: JsonWalkTarget;
}

interface JsonWalkTarget {
	frame: JsonWalkFrame | undefined;
	index: number;
}

type JsonWalkEvent =
	| { type: "visit"; value: unknown; depth: number; target: JsonWalkTarget }
	| { type: "key"; key: string; frame: JsonWalkFrame; index: number }
	| { type: "complete"; frame: JsonWalkFrame };

/**
 * Map every string in bounded JSON, including object keys.
 *
 * The explicit stack prevents call-stack exhaustion. Gray/done memo states reject cycles and map
 * shared DAG nodes once, while completion allocates only containers whose key or value changed.
 * Arrays and plain records are the complete walk domain; typed arrays and class instances are
 * rejected before their properties can be enumerated byte-by-byte.
 */
export function mapJsonStrings<T>(value: T, fn: (s: string) => string): T {
	const memo = new WeakMap<object, { status: "visiting" | "done"; result?: unknown }>();
	const events: JsonWalkEvent[] = [
		{ type: "visit", value, depth: 0, target: { frame: undefined, index: 0 } },
	];
	let rootResult: unknown;
	let visitedNodes = 0;
	let visitedKeys = 0;
	let inputStringBytes = 0;
	let outputStringBytes = 0;

	const mapString = (input: string): string => {
		if (!isWellFormedUtf16(input)) {
			throw new Error("Refusing ill-formed UTF-16 in JSON transformation data.");
		}
		inputStringBytes += utf8ByteLengthInRange(input);
		if (inputStringBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			throw new Error("Refusing a JSON transformation above the cumulative input string-byte limit.");
		}
		const output = fn(input);
		if (typeof output !== "string" || !isWellFormedUtf16(output)) {
			throw new Error("Refusing an ill-formed string produced by a JSON transformation.");
		}
		outputStringBytes += utf8ByteLengthInRange(output);
		if (outputStringBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			throw new Error("Refusing a JSON transformation above the cumulative output string-byte limit.");
		}
		return output;
	};

	const assign = (target: JsonWalkTarget, result: unknown): void => {
		if (target.frame === undefined) rootResult = result;
		else target.frame.mappedValues[target.index] = result;
	};

	while (events.length > 0) {
		const event = events.pop();
		if (event === undefined) break;
		if (event.type === "key") {
			event.frame.mappedKeys[event.index] = mapString(event.key);
			continue;
		}
		if (event.type === "complete") {
			const frame = event.frame;
			let changed = false;
			if (frame.kind === "array") {
				for (let index = 0; index < frame.sourceValues.length; index++) {
					if (frame.mappedValues[index] !== frame.sourceValues[index]) {
						changed = true;
						break;
					}
				}
				let result: unknown = frame.original;
				if (changed) {
					const output = (frame.original as unknown[]).slice();
					for (let index = 0; index < frame.sourceValues.length; index++) {
						if (frame.mappedValues[index] !== frame.sourceValues[index]) {
							output[index] = frame.mappedValues[index];
						}
					}
					result = output;
				}
				assign(frame.target, result);
				const memoEntry = memo.get(frame.original);
				if (memoEntry === undefined) throw new Error("JSON transformation memo state was lost.");
				memoEntry.status = "done";
				memoEntry.result = result;
				continue;
			}

			const seenKeys = new Set<string>();
			for (let index = 0; index < frame.keys.length; index++) {
				const mappedKey = frame.mappedKeys[index];
				if (seenKeys.has(mappedKey)) {
					throw new Error("Refusing to rewrite two JSON object fields as the same protected key.");
				}
				seenKeys.add(mappedKey);
				if (mappedKey !== frame.keys[index] || frame.mappedValues[index] !== frame.sourceValues[index]) {
					changed = true;
				}
			}
			let result: unknown = frame.original;
			if (changed) {
				const output = Object.create(frame.prototype) as Record<string, unknown>;
				for (let index = 0; index < frame.keys.length; index++) {
					Object.defineProperty(output, frame.mappedKeys[index], {
						value: frame.mappedValues[index],
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
				result = output;
			}
			assign(frame.target, result);
			const memoEntry = memo.get(frame.original);
			if (memoEntry === undefined) throw new Error("JSON transformation memo state was lost.");
			memoEntry.status = "done";
			memoEntry.result = result;
			continue;
		}

		const current = event.value;
		if (typeof current === "string") {
			if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
				throw new Error("Refusing a JSON transformation above the node limit.");
			}
			assign(event.target, mapString(current));
			continue;
		}
		if (
			current === null ||
			current === undefined ||
			typeof current === "boolean" ||
			(typeof current === "number" && Number.isFinite(current))
		) {
			if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
				throw new Error("Refusing a JSON transformation above the node limit.");
			}
			assign(event.target, current);
			continue;
		}
		if (typeof current !== "object") {
			throw new Error("Refusing a non-JSON value in secret transformation data.");
		}
		if (event.depth > MAX_JSON_TRANSFORM_DEPTH) {
			throw new Error("Refusing a JSON transformation above the depth limit.");
		}
		const existingMemo = memo.get(current);
		if (existingMemo?.status === "visiting") {
			throw new Error("Refusing a cyclic JSON transformation graph.");
		}
		if (existingMemo?.status === "done") {
			assign(event.target, existingMemo.result);
			continue;
		}
		if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
			throw new Error("Refusing a JSON transformation above the node limit.");
		}

		const isArray = Array.isArray(current);
		const prototype = Object.getPrototypeOf(current);
		if (!isArray && prototype !== Object.prototype && prototype !== null) {
			throw new Error("Refusing a non-plain object in JSON transformation data.");
		}
		const keys: string[] = [];
		const sourceValues: unknown[] = [];
		if (isArray) {
			if (current.length > MAX_JSON_TRANSFORM_NODES - visitedNodes) {
				throw new Error("Refusing a JSON transformation above the array-item limit.");
			}
			for (let index = 0; index < current.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
				if (descriptor !== undefined && !("value" in descriptor)) {
					throw new Error("Refusing an accessor property in JSON transformation data.");
				}
				keys.push(String(index));
				sourceValues.push(descriptor?.value);
			}
		} else {
			const record = current as Record<string, unknown>;
			if (Object.getOwnPropertySymbols(record).some(symbol => Object.getOwnPropertyDescriptor(record, symbol)?.enumerable)) {
				throw new Error("Refusing an enumerable symbol key in JSON transformation data.");
			}
			for (const key in record) {
				if (!Object.hasOwn(record, key)) continue;
				if (++visitedKeys > MAX_JSON_TRANSFORM_KEYS) {
					throw new Error("Refusing a JSON transformation above the object-key limit.");
				}
				const descriptor = Object.getOwnPropertyDescriptor(record, key);
				if (descriptor === undefined || !("value" in descriptor)) {
					throw new Error("Refusing an accessor property in JSON transformation data.");
				}
				keys.push(key);
				sourceValues.push(descriptor.value);
			}
		}

		const frame: JsonWalkFrame = {
			original: current as unknown[] | Record<string, unknown>,
			kind: isArray ? "array" : "object",
			keys,
			sourceValues,
			mappedKeys: isArray ? keys : new Array(keys.length),
			mappedValues: new Array(sourceValues.length),
			prototype,
			target: event.target,
		};
		memo.set(current, { status: "visiting" });
		assign(event.target, current);
		events.push({ type: "complete", frame });
		for (let index = sourceValues.length - 1; index >= 0; index--) {
			events.push({
				type: "visit",
				value: sourceValues[index],
				depth: event.depth + 1,
				target: { frame, index },
			});
			if (!isArray) events.push({ type: "key", key: keys[index], frame, index });
		}
	}

	return rootResult as T;
}

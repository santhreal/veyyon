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

/**
 * Generate a machine-keyed same-length replacement.
 *
 * Rejection sampling removes modulo bias from the 62-character alphabet. Counter-mode HMAC
 * extends the output to arbitrary lengths without exposing a provider-verifiable hash oracle.
 */
function generateDeterministicReplacement(secret: string, key: Uint8Array, attempt = 0): string {
	const chars: string[] = [];
	for (let counter = 0; chars.length < secret.length; counter++) {
		const digest = crypto
			.createHmac("sha256", key)
			.update(`replacement\0${attempt}\0${counter}\0${secret}`, "utf8")
			.digest();
		for (const byte of digest) {
			if (byte >= 248) continue;
			chars.push(REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length]);
			if (chars.length === secret.length) break;
		}
	}
	return chars.join("");
}

/** Refuse one-way replacement text that could later be expanded as a live credential. */
function assertOneWayReplacement(replacement: string): void {
	for (const token of replacement.match(PLACEHOLDER_RE) ?? []) {
		if (isSecretPlaceholder(token)) {
			throw new Error("Refusing a secret replacement that contains a reversible secret placeholder.");
		}
	}
}

/** Refuse a replacement that would put any configured secret back on the wire. */
function resolveSafeReplacement(
	secret: string,
	preferred: string | undefined,
	forbidden: readonly string[],
	key: Uint8Array,
): string {
	if (preferred !== undefined) assertOneWayReplacement(preferred);
	if (preferred !== undefined) {
		if (preferred === secret || forbidden.some(value => value.length > 0 && preferred.includes(value))) {
			throw new Error("Refusing a secret replacement that contains a configured secret.");
		}
		return preferred;
	}
	for (let attempt = 0; attempt < 256; attempt++) {
		const candidate = generateDeterministicReplacement(secret, key, attempt);
		if (!forbidden.some(value => value.length > 0 && candidate.includes(value))) return candidate;
	}
	throw new Error("Could not generate a replacement that is distinct from every configured secret.");
}

// ═══════════════════════════════════════════════════════════════════════════
// SecretObfuscator
// ═══════════════════════════════════════════════════════════════════════════

interface ProtectedSpan {
	start: number;
	end: number;
}

interface ProtectedText {
	text: string;
	spans: ProtectedSpan[];
}

interface TextReplacement extends ProtectedSpan {
	replacement: string;
}

export class SecretObfuscator {
	/** Reversible and retired plain secrets: secret → provider-safe placeholder. */
	#plainMappings = new Map<string, string>();

	/** Contextual regex matches: secret → placeholder, never applied outside a regex span. */
	#regexMappings = new Map<string, string>();

	/** Regex entries (patterns compiled at construction) */
	#regexEntries: Array<{
		regex: RegExp;
		mode: "obfuscate" | "replace";
		replacement?: string;
		/** Floor for this pattern's matches: its own `minLength`, else the default. */
		minLength: number;
		/** Position in the constructor's input, so a rejection can name the entry. */
		entryIndex: number;
	}> = [];

	/** Replace-mode plain mappings: secret → replacement */
	#replaceMappings = new Map<string, string>();

	/** Reverse lookup for deobfuscation: placeholder → secret */
	#deobfuscateMap = new Map<string, string>();

	/** HMAC key for unnamed placeholders. Never leaves this object. */
	#placeholderKey: Uint8Array;

	/** Values known to be sensitive, including regex matches discovered at runtime. */
	#knownSecretValues = new Set<string>();

	/** Whether any secrets were configured */
	#hasAny: boolean;

	/**
	 * Declared secrets this obfuscator could not protect.
	 *
	 * Carried out instead of dropped. Every caller that builds an obfuscator has to
	 * surface these, because an unprotected declared secret is the failure this whole
	 * module exists to prevent, and the operator is the only one who can fix it.
	 */
	#rejections: SecretRejection[] = [];

	/** Pattern entry indexes that have already reported an over-match, to warn once each. */
	#reportedOvermatch = new Set<number>();

	/** Told about every rejection as it happens. See {@link SecretObfuscatorOptions}. */
	#onRejection: ((rejection: SecretRejection) => void) | undefined;

	#onExpiry: ((name: string) => void) | undefined;

	#now: () => number;

	/**
	 * Placeholder → the moment it stops being substituted. Only entries that actually expire.
	 *
	 * Keyed by placeholder rather than by name so the expiry check is one map lookup away from the
	 * substitution map it has to modify.
	 */
	#expiryByPlaceholder = new Map<string, number>();

	/**
	 * Soonest expiry in {@link #expiryByPlaceholder}, or `Infinity` when nothing expires.
	 *
	 * THE REASON EXPIRY COSTS NOTHING ON THE HOT PATH. `deobfuscate` runs on every string of every
	 * tool call, so a scan of the expiry map per call would be a real cost for a check that almost
	 * never fires (Law 7). One number compared against the clock answers "could anything have
	 * expired since last time" in constant time, and the scan happens only on the single call that
	 * crosses a deadline.
	 */
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

	constructor(entries: SecretEntry[], options?: SecretObfuscatorOptions) {
		this.#onRejection = options?.onRejection;
		this.#onExpiry = options?.onExpiry;
		this.#now = options?.now ?? Date.now;
		this.#placeholderKey = options?.placeholderKey ?? PROCESS_PLACEHOLDER_KEY;
		const configuredPlainValues = entries.filter(entry => entry.type === "plain").map(entry => entry.content);
		let hasRealSecret = false;

		for (const [entryIndex, entry] of entries.entries()) {
			const mode = entry.mode ?? "obfuscate";
			if (entry.type === "plain" && mode === "replace" && entry.content.length === 0) {
				throw new Error("Refusing an empty plain secret, which cannot protect or replace any bytes.");
			}
			if (mode === "replace" && entry.replacement !== undefined) assertOneWayReplacement(entry.replacement);
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
					this.#replaceMappings.set(
						entry.content,
						resolveSafeReplacement(entry.content, entry.replacement, configuredPlainValues, this.#placeholderKey),
					);
					this.#knownSecretValues.add(entry.content);
				}
				hasRealSecret = true;
				continue;
			}

			try {
				const regex = compileSecretRegex(entry.content, entry.flags);
				this.#regexEntries.push({
					regex,
					mode,
					replacement: entry.replacement,
					minLength: entry.minLength ?? MIN_OBFUSCATABLE_LENGTH,
					entryIndex,
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

	/** Install one reversible mapping, retiring an older value that used the same name. */
	#registerReversible(secret: string, placeholder: string, expiresAt?: number | null): void {
		const existing = this.#deobfuscateMap.get(placeholder);
		if (existing !== undefined && existing !== secret) this.#forgetPlaceholder(placeholder);
		this.#knownSecretValues.add(secret);
		this.#plainMappings.set(secret, placeholder);
		this.#deobfuscateMap.set(placeholder, secret);
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
	}

	/**
	 * Start protecting one more named secret, mid-session.
	 *
	 * A rotation retires the old value to its opaque value placeholder before the name is
	 * rebound. Historical occurrences therefore stay redacted without expanding to the new
	 * credential. Returns the readable placeholder the model should use.
	 */
	addNamedSecret(name: string, value: string, expiresAt?: number | null): string {
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
		if (expiresAt === undefined || expiresAt === null) {
			this.#expiryByPlaceholder.delete(placeholder);
		} else {
			this.#expiryByPlaceholder.set(placeholder, expiresAt);
		}
		this.#recomputeNextExpiry();
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
		if (now < this.#nextExpiryAt) return;

		for (const [placeholder, at] of [...this.#expiryByPlaceholder]) {
			if (at > now) continue;
			this.#expiryByPlaceholder.delete(placeholder);
			this.#forgetPlaceholder(placeholder);
			// Told, not dropped quietly. A command that runs with the placeholder still in it fails
			// with a 401 and no explanation anywhere, which is the most confusing outcome available.
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

	#forgetPlaceholder(placeholder: string): void {
		const value = this.#deobfuscateMap.get(placeholder);
		if (value === undefined) return;
		this.#deobfuscateMap.delete(placeholder);
		this.#expiryByPlaceholder.delete(placeholder);
		if (this.#plainMappings.get(value) === placeholder) {
			this.#plainMappings.set(value, this.#buildValuePlaceholder(value));
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
		let state: ProtectedText = { text, spans: this.#protectedPlaceholderSpans(text) };
		state = this.#applyPlainRules(state);

		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const replacements: TextReplacement[] = [];
			let protectedIndex = 0;
			for (;;) {
				const match = entry.regex.exec(state.text);
				if (match === null) break;
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

				const characterLength = Array.from(matchValue).length;
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

				this.#knownSecretValues.add(matchValue);
				let replacement: string;
				if (entry.mode === "replace") {
					replacement = resolveSafeReplacement(
						matchValue,
						entry.replacement,
						[...this.#knownSecretValues],
						this.#placeholderKey,
					);
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

			if (replacements.length > 0) state = this.#applyProtectedReplacements(state, replacements);
		}

		return this.#applyPlainRules(state).text;
	}

	/** Locate already-emitted placeholders so no rule can reinterpret their bytes. */
	#protectedPlaceholderSpans(text: string): ProtectedSpan[] {
		if (!text.includes("#")) return [];
		const placeholders = new Set([...this.#plainMappings.values(), ...this.#regexMappings.values()]);
		if (placeholders.size === 0) return [];
		const spans: ProtectedSpan[] = [];
		PLACEHOLDER_RE.lastIndex = 0;
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (placeholders.has(match[0])) spans.push({ start: match.index, end: match.index + match[0].length });
		}
		PLACEHOLDER_RE.lastIndex = 0;
		return spans;
	}

	/** Apply non-overlapping replacements while carrying protected output spans forward. */
	#applyProtectedReplacements(state: ProtectedText, replacements: readonly TextReplacement[]): ProtectedText {
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
			if (outputLength > protectedStart) spans.push({ start: protectedStart, end: outputLength });
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
		const rules = [
			...[...this.#plainMappings].map(([secret, replacement]) => ({ secret, replacement })),
			...[...this.#replaceMappings].map(([secret, replacement]) => ({ secret, replacement })),
		].filter(rule => rule.secret.length > 0);
		if (rules.length === 0) return state;
		rules.sort((a, b) => b.secret.length - a.secret.length);
		const nextPositions = rules.map(rule => state.text.indexOf(rule.secret));
		const chunks: string[] = [];
		const spans: ProtectedSpan[] = [];
		let outputLength = 0;
		let cursor = 0;
		let spanIndex = 0;
		const append = (part: string): void => {
			chunks.push(part);
			outputLength += part.length;
		};

		while (cursor < state.text.length) {
			while (spanIndex < state.spans.length && state.spans[spanIndex].end <= cursor) spanIndex++;
			const span = state.spans[spanIndex];
			let nextRuleIndex = -1;
			let nextRuleAt = Number.POSITIVE_INFINITY;
			for (let index = 0; index < rules.length; index++) {
				let at = nextPositions[index];
				if (at >= 0 && at < cursor) {
					at = state.text.indexOf(rules[index].secret, cursor);
					nextPositions[index] = at;
				}
				if (at < 0 || at > nextRuleAt) continue;
				if (
					at < nextRuleAt ||
					nextRuleIndex < 0 ||
					rules[index].secret.length > rules[nextRuleIndex].secret.length
				) {
					nextRuleIndex = index;
					nextRuleAt = at;
				}
			}

			if (
				span !== undefined &&
				nextRuleIndex >= 0 &&
				nextRuleAt < span.start &&
				nextRuleAt + rules[nextRuleIndex].secret.length > span.start
			) {
				nextPositions[nextRuleIndex] = state.text.indexOf(rules[nextRuleIndex].secret, span.end);
				continue;
			}

			if (span !== undefined && span.start <= nextRuleAt) {
				append(state.text.slice(cursor, span.start));
				const protectedStart = outputLength;
				append(state.text.slice(span.start, span.end));
				spans.push({ start: protectedStart, end: outputLength });
				cursor = span.end;
				spanIndex++;
				continue;
			}
			if (nextRuleIndex < 0 || nextRuleAt === Number.POSITIVE_INFINITY) {
				append(state.text.slice(cursor));
				break;
			}

			const rule = rules[nextRuleIndex];
			append(state.text.slice(cursor, nextRuleAt));
			const protectedStart = outputLength;
			append(rule.replacement);
			if (outputLength > protectedStart) spans.push({ start: protectedStart, end: outputLength });
			cursor = nextRuleAt + rule.secret.length;
			nextPositions[nextRuleIndex] = state.text.indexOf(rule.secret, cursor);
		}
		return { text: chunks.join(""), spans };
	}

	/** Deobfuscate live reversible placeholders. Retired and expired placeholders stay opaque. */
	deobfuscate(text: string): string {
		if (!this.#hasAny || !text.includes("#")) return text;
		this.#forgetExpired();
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

		const content =
			typeof message.content === "string"
				? obfuscator.obfuscate(message.content)
				: obfuscateTextBlocks(obfuscator, message.content);
		if ("providerPayload" in message && message.providerPayload !== undefined) {
			assertOpaqueProviderPayloadSafe(obfuscator, message.providerPayload);
		}
		if (message.role === "toolResult") {
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

/**
 * Map every string in arbitrary JSON, including object keys. Used for provider-bound schemas,
 * examples, opaque replay payloads, and tool arguments. Copies are allocated only along changed
 * paths. A mapped-key collision fails closed instead of silently discarding one JSON field.
 */
export function mapJsonStrings<T>(value: T, fn: (s: string) => string): T {
	if (typeof value === "string") return fn(value) as T;
	if (Array.isArray(value)) {
		let out: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = mapJsonStrings(item, fn);
			if (next !== item) {
				out ??= value.slice();
				out[index] = next;
			}
		}
		return (out ?? value) as T;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		let out: Record<string, unknown> | undefined;
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			const item = record[key];
			const nextKey = fn(key);
			const next = mapJsonStrings(item, fn);
			if (out === undefined && (nextKey !== key || next !== item)) {
				out = {};
				for (let prior = 0; prior < index; prior++) {
					const priorKey = keys[prior];
					Object.defineProperty(out, priorKey, {
						value: record[priorKey],
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
			}
			if (out !== undefined) {
				if (Object.hasOwn(out, nextKey)) {
					throw new Error("Refusing to rewrite two JSON object fields as the same protected key.");
				}
				Object.defineProperty(out, nextKey, {
					value: next,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
		return (out ?? value) as T;
	}
	return value;
}

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
import { buildNamePlaceholder, buildValuePlaceholder, isValidSecretName, PLACEHOLDER_RE } from "./placeholder";
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH, type SecretRejection } from "./policy";
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

/** Generate a deterministic same-length replacement that is never the input itself. */
function generateDeterministicReplacement(secret: string, attempt = 0): string {
	const hash = BigInt(Bun.hash(`${attempt}\0${secret}`));
	const chars: string[] = [];
	let h = hash;
	for (let i = 0; i < secret.length; i++) {
		h ^= BigInt(i + 1) * 0x9e3779b97f4a7c15n;
		const idx = Number((h < 0n ? -h : h) % BigInt(REPLACEMENT_CHARS.length));
		chars.push(REPLACEMENT_CHARS[idx]);
	}
	const candidate = chars.join("");
	return candidate === secret ? generateDeterministicReplacement(secret, attempt + 1) : candidate;
}

/** Refuse a replacement that would put any configured secret back on the wire. */
function resolveSafeReplacement(secret: string, preferred: string | undefined, forbidden: readonly string[]): string {
	if (preferred !== undefined) {
		if (preferred === secret || forbidden.some(value => value.length > 0 && preferred.includes(value))) {
			throw new Error("Refusing a secret replacement that contains a configured secret.");
		}
		return preferred;
	}
	for (let attempt = 0; attempt < 256; attempt++) {
		const candidate = generateDeterministicReplacement(secret, attempt);
		if (!forbidden.some(value => value.length > 0 && candidate.includes(value))) return candidate;
	}
	throw new Error("Could not generate a replacement that is distinct from every configured secret.");
}

// ═══════════════════════════════════════════════════════════════════════════
// SecretObfuscator
// ═══════════════════════════════════════════════════════════════════════════

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
			if (entry.type === "plain") {
				if (mode === "obfuscate") {
					if (!canObfuscatePlainValue(entry.content)) {
						this.#reject({
							reason: "too-short-to-obfuscate",
							index: entryIndex,
							length: entry.content.length,
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
						resolveSafeReplacement(entry.content, entry.replacement, configuredPlainValues),
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
				`Refusing to add ${name}: the value is ${value.length} characters, under the ` +
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
		let result = this.#applyPlainRules(text);

		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const replacements: Array<{ start: number; end: number; replacement: string }> = [];
			for (;;) {
				const match = entry.regex.exec(result);
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
					replacement = resolveSafeReplacement(matchValue, entry.replacement, [...this.#knownSecretValues]);
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
				replacements.push({
					start: match.index,
					end: match.index + matchValue.length,
					replacement,
				});
			}

			if (replacements.length > 0) {
				let cursor = 0;
				let rewritten = "";
				for (const replacement of replacements) {
					rewritten += result.slice(cursor, replacement.start);
					rewritten += replacement.replacement;
					cursor = replacement.end;
				}
				result = rewritten + result.slice(cursor);
			}
		}

		return this.#applyPlainRules(result);
	}

	/**
	 * Apply every literal rule against the same input view.
	 *
	 * One-pass selection prevents a replacement from being reinterpreted as another secret.
	 * At a shared position the longest value wins. Placeholders already emitted by this
	 * obfuscator are copied atomically, so a one-character replace secret cannot corrupt them.
	 */
	#applyPlainRules(text: string): string {
		const rules = [
			...[...this.#plainMappings].map(([secret, replacement]) => ({ secret, replacement })),
			...[...this.#replaceMappings].map(([secret, replacement]) => ({ secret, replacement })),
		].filter(rule => rule.secret.length > 0);
		if (rules.length === 0) return text;
		rules.sort((a, b) => b.secret.length - a.secret.length);
		const placeholders = [...new Set(this.#plainMappings.values())];
		let cursor = 0;
		let output = "";

		while (cursor < text.length) {
			let nextRule: (typeof rules)[number] | undefined;
			let nextRuleAt = Number.POSITIVE_INFINITY;
			for (const rule of rules) {
				const at = text.indexOf(rule.secret, cursor);
				if (at < 0 || at > nextRuleAt) continue;
				if (at < nextRuleAt || nextRule === undefined || rule.secret.length > nextRule.secret.length) {
					nextRule = rule;
					nextRuleAt = at;
				}
			}

			let nextPlaceholder: string | undefined;
			let nextPlaceholderAt = Number.POSITIVE_INFINITY;
			for (const placeholder of placeholders) {
				const at = text.indexOf(placeholder, cursor);
				if (at >= 0 && at < nextPlaceholderAt) {
					nextPlaceholder = placeholder;
					nextPlaceholderAt = at;
				}
			}

			if (nextPlaceholder !== undefined && nextPlaceholderAt <= nextRuleAt) {
				output += text.slice(cursor, nextPlaceholderAt) + nextPlaceholder;
				cursor = nextPlaceholderAt + nextPlaceholder.length;
				continue;
			}
			if (nextRule === undefined || nextRuleAt === Number.POSITIVE_INFINITY) {
				output += text.slice(cursor);
				break;
			}
			output += text.slice(cursor, nextRuleAt) + nextRule.replacement;
			cursor = nextRuleAt + nextRule.secret.length;
		}
		return output;
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
	return mapAssistantContentStrings(content, s => obfuscator.deobfuscate(s));
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
			const intent = block.intent === undefined ? undefined : fn(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : fn(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
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

/** Obfuscate `text` blocks of a content array; image and other blocks pass through. */
function obfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	return mapTextBlockStrings(content, text => obfuscator.obfuscate(text));
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
 * Assistant text is included because resumed transcripts can contain locally restored
 * placeholders or hook-injected raw values. Thinking signatures remain byte-identical, since
 * providers authenticate them against the original thinking bytes.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	if (!obfuscator.hasSecrets()) return messages;
	let changed = false;
	const result = messages.map((message): Message => {
		if (message.role === "assistant") {
			const content = mapAssistantContentStrings(message.content, text => obfuscator.obfuscate(text));
			const providerPayload =
				message.providerPayload === undefined
					? undefined
					: mapJsonStrings(message.providerPayload, text => obfuscator.obfuscate(text));
			if (content === message.content && providerPayload === message.providerPayload) return message;
			changed = true;
			return { ...message, content, providerPayload };
		}

		const content =
			typeof message.content === "string"
				? obfuscator.obfuscate(message.content)
				: obfuscateTextBlocks(obfuscator, message.content);
		const originalProviderPayload = "providerPayload" in message ? message.providerPayload : undefined;
		const providerPayload =
			originalProviderPayload === undefined
				? undefined
				: mapJsonStrings(originalProviderPayload, text => obfuscator.obfuscate(text));
		if (content === message.content && providerPayload === originalProviderPayload) return message;
		changed = true;
		return originalProviderPayload === undefined
			? ({ ...message, content } as Message)
			: ({ ...message, content, providerPayload } as Message);
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
 * Map every string in arbitrary JSON. Used for provider-bound schemas, examples, opaque
 * replay payloads, and tool arguments. Copies are allocated only along changed paths.
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
		let out: Record<string, unknown> | undefined;
		for (const key of Object.keys(record)) {
			const item = record[key];
			const next = mapJsonStrings(item, fn);
			if (next !== item) {
				out ??= { ...record };
				out[key] = next;
			}
		}
		return (out ?? value) as T;
	}
	return value;
}

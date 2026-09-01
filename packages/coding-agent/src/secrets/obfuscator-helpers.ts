import * as crypto from "node:crypto";
import { isWellFormedUtf16, utf8ByteLength } from "@veyyon/utils/string-length";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "./placeholder";
import type { SecretRejection } from "./policy";

export const SECRET_ORIGINS = ["vault", "environment", "config"] as const;

export type SecretOrigin = (typeof SECRET_ORIGINS)[number];

export function mayRestoreForDisplay(entry: SecretEntry): boolean {
	return entry.type === "regex" && entry.origin === "config";
}

export interface SecretEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
	minLength?: number;
	name?: string;
	expiresAt?: number | null;
	origin: SecretOrigin;
	source?: string;
}

export interface SecretExpiryEvent {
	name: string;
	persistedCiphertextRemoved: boolean;
}

export function describeSecretExpiry(event: SecretExpiryEvent): string {
	const persistedState = event.persistedCiphertextRemoved
		? "Its encrypted value was deleted from the vault."
		: "Its encrypted value has not yet been deleted from the vault; a successful vault refresh will prune it.";
	return (
		`#${event.name}# has expired and its in-memory expansion has been revoked. ${persistedState} ` +
		`Store it again with /secret from-env <VAR> if you still need it, or ` +
		`/secret from-env <VAR> ${event.name} in a client with no terminal.`
	);
}

export interface SecretObfuscatorOptions {
	onRejection?: (rejection: SecretRejection) => void;
	onExpiry?: (event: SecretExpiryEvent) => void;
	now?: () => number;
	placeholderKey?: Uint8Array;
}

export interface MaskedInventory {
	count: number;
	sources: readonly string[];
	unlabelled: number;
}

export const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const PROCESS_PLACEHOLDER_KEY = crypto.randomBytes(32);

export const MAX_SECRET_ENTRIES = 10_000;
export const MAX_SECRET_REGEX_ENTRIES = 256;
export const MAX_SECRET_VALUE_BYTES = 1024 * 1024;
export const MAX_TRANSFORMED_TEXT_BYTES = 16 * 1024 * 1024;
export const MAX_SECRET_MATCHES_PER_TEXT = 20_000;
export const MAX_PLACEHOLDERS_PER_TEXT = 10_000;
export const MAX_RUNTIME_SECRET_VALUES = 10_000;
export const MAX_RUNTIME_SECRET_BYTES = 8 * 1024 * 1024;
export const MAX_CONFIGURED_SECRET_BYTES = 16 * 1024 * 1024;
export const MAX_LONG_TERMINAL_ALIASES = 16;
export const SHORT_ALIAS_TRIE_CODE_UNITS = 256;
export const MAX_TERMINAL_ALIAS_BYTES = 16 * 1024 * 1024;

export interface LiteralMatcherNode<T> {
	children: Map<string, number>;
	fail: number;
	outputLink: number;
	outputs: Array<{ literal: string; value: T }>;
}

export class LiteralMatcher<T> {
	readonly #nodes: Array<LiteralMatcherNode<T>> = [{ children: new Map(), fail: 0, outputLink: 0, outputs: [] }];
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
				child.outputLink = this.#nodes[failure].outputs.length > 0 ? failure : this.#nodes[failure].outputLink;
				queue.push(childIndex);
			}
		}
	}

	forEachMatch(
		text: string,
		visit: (start: number, end: number, value: T, literal: string) => boolean | undefined,
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
			for (let start = text.indexOf(output.literal); start >= 0; start = text.indexOf(output.literal, start + 1)) {
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

export function assertBoundedSecretString(value: string): void {
	if (!isWellFormedUtf16(value)) {
		throw new Error("Refusing ill-formed UTF-16 in secret transformation data.");
	}
	if (utf8ByteLength(value) > MAX_SECRET_VALUE_BYTES) {
		throw new Error("Refusing secret transformation data above the per-value byte limit.");
	}
}

export function assertBoundedTransformText(value: string): number {
	const bytes = utf8ByteLength(value);
	if (bytes > MAX_TRANSFORMED_TEXT_BYTES) {
		throw new Error("Refusing a secret transformation above the text byte limit.");
	}
	return bytes;
}

export function generateDeterministicReplacement(
	secret: string,
	key: Uint8Array,
	forbidden: LiteralMatcher<true>,
): string {
	const seed = crypto.createHmac("sha256", key).update("replacement-source\0", "utf8").update(secret, "utf8").digest();
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

export function assertOneWayReplacement(replacement: string): void {
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

export function resolveSafeReplacement(
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

export interface ProtectedSpan {
	start: number;
	end: number;
	allowContainingLiteral?: boolean;
}

export interface ProtectedText {
	text: string;
	spans: ProtectedSpan[];
}

export interface TextReplacement extends ProtectedSpan {
	replacement: string;
}
export interface LiteralRule {
	replacement: string;
}

export interface CompiledRegexEntry {
	regex: RegExp;
	mode: "obfuscate" | "replace";
	replacement?: string;
	minLength: number;
	entryIndex: number;
	aliases: Map<string, string>;
	displayRestorable: boolean;
}

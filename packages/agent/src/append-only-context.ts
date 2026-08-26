/**
 * Append-only context mode — stabilizes the byte prefix sent to the LLM
 * across turns so provider prefix caches (DeepSeek, Anthropic, etc.)
 * hit at the maximum possible rate.
 *
 * Two mechanisms:
 *
 * 1. **StablePrefix** — system prompt + tool specs are computed once
 *    and frozen. Subsequent turns reuse the exact same byte sequence
 *    unless `invalidate()` is called (e.g. after MCP reconnect).
 *
 * 2. **AppendOnlyLog** — messages only grow; prior turns are never
 *    re-serialized. Combined with a stable prefix, only the user's new
 *    message delta is a cache miss each turn.
 */

import type { Context, Message, Tool } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
import { normalizeTools } from "./agent-loop";
import type { AgentContext } from "./types";

/** True when a message's content array contains at least one image block. */
function messageHasImages(msg: Message): boolean {
	return Array.isArray(msg.content) && msg.content.some(part => part.type === "image");
}

// ---------------------------------------------------------------------------
// StablePrefix (formerly ImmutablePrefix)
// ---------------------------------------------------------------------------

/** Frozen system prompt + tool spec snapshot. */
export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

/** Options threaded through `build()` so the snapshot reflects loop-time settings. */
export interface BuildOptions {
	/** Inject the `i` intent field into tool schemas (must match agent-loop's normalizeTools). */
	intentTracing: boolean;
	exampleDialect?: Dialect;
	/** Strip tool descriptions from the provider-bound specs (must match normalizeTools). */
	pruneToolDescriptions?: boolean;
}

/** Frozen prefix (system prompt + tools) producing stable bytes across `build()` calls; reuses cached copy until `invalidate()` or fingerprint change. */
type FpCache = BuildOptions & { systemPrompt: unknown; tools: unknown; fingerprint: string };
export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;
	#fpCache: FpCache | null = null;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	/** Build or rebuild from live context. Returns `true` if the prefix changed. */
	build(context: AgentContext, options: BuildOptions): boolean {
		const tools =
			normalizeTools(context.tools, options.intentTracing, options.exampleDialect, options.pruneToolDescriptions) ??
			[];
		const fingerprint = this.#computeFingerprintCached(context.systemPrompt, tools, options);
		if (this.#snapshot && this.#snapshot.fingerprint === fingerprint) {
			return false;
		}
		this.#snapshot = {
			systemPrompt: [...context.systemPrompt],
			tools,
			fingerprint,
		};
		this.#version++;
		return true;
	}

	#computeFingerprintCached(systemPrompt: string[], tools: Tool[], options: BuildOptions): string {
		const c = this.#fpCache;
		if (
			c &&
			c.systemPrompt === systemPrompt &&
			c.tools === tools &&
			c.intentTracing === options.intentTracing &&
			c.exampleDialect === options.exampleDialect &&
			c.pruneToolDescriptions === options.pruneToolDescriptions
		)
			return c.fingerprint;
		const fingerprint = computeFingerprint(systemPrompt, tools, options);
		this.#fpCache = { ...options, systemPrompt, tools, fingerprint };
		return fingerprint;
	}

	/** Force rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
		this.#fpCache = null;
	}

	/**
	 * Returns the cached prefix.
	 * @throws if `build()` was never called.
	 */
	toContext(): { systemPrompt: string[]; tools: Tool[] } {
		const s = this.#snapshot;
		if (!s) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: s.systemPrompt, tools: s.tools };
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

/**
 * Append-only message log at the `Message[]` (provider-level) layer.
 *
 * The only mutation path is `replaceTail()`, reserved for compaction.
 * Every other operation is append-only.
 */
export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: Message): void {
		this.#entries.push(message);
	}

	extend(messages: Message[]): void {
		for (const m of messages) this.#entries.push(m);
	}

	/** Replace the last entry — only legal for compaction. */
	replaceTail(replacement: Message): void {
		const idx = this.#entries.length - 1;
		if (idx >= 0) this.#entries[idx] = replacement;
	}

	/** Returns a shallow copy of all entries. */
	toMessages(): Message[] {
		return this.#entries.slice();
	}

	/** Direct readonly access for in-place inspection. */
	entries(): readonly Message[] {
		return this.#entries;
	}

	/** Drop entries past index `count`, keeping the first `count` byte-stable.
	 * Used by {@link AppendOnlyContextManager.syncMessages} to preserve the
	 * already-on-the-wire prefix when a later message diverges. */
	truncate(count: number): void {
		if (count < 0) count = 0;
		if (count >= this.#entries.length) return;
		this.#entries.length = count;
	}

	clear(): void {
		this.#entries = [];
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

/** Manages a stable prefix + append-only log for the agent loop. Call `build(context)` each turn for stable system prompt, tools, and append-only messages; call `syncMessages(normalizedMessages)` after `convertToLlm` to grow the log. */
export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	/** How many normalized messages were synced into the log as of the last sync. */
	#lastSyncCount = 0;
	/** Per-message digests: preserve byte-stable prefix across rewrites to keep provider prompt-cache warm. */
	#messageDigests: number[] = [];
	/** Incrementally tracked: lets the image policy skip an O(n*blocks) scan when there are no images. */
	#hasImages = false;

	/** True when any message in the log contains an image block. */
	get hasImages(): boolean {
		return this.#hasImages;
	}

	build(context: AgentContext, options: BuildOptions): Context {
		this.prefix.build(context, options);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	#rescanImages(): void {
		this.#hasImages = this.log.entries().some(messageHasImages);
	}
	/** Sync normalized messages: append (same prefix), compaction (shorter), or in-place rewrite (trim to byte-stable prefix, re-append diverged tail). Preserving the prefix keeps provider KV cache warm (#3406). */
	syncMessages(normalizedMessages: Message[]): void {
		if (normalizedMessages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
			this.#messageDigests = [];
			this.#hasImages = false;
		}
		if (this.#lastSyncCount > 0) {
			const stableCount = Math.min(this.#longestStablePrefix(normalizedMessages), this.log.length);
			if (stableCount < this.#lastSyncCount) {
				this.log.truncate(stableCount);
				this.#lastSyncCount = stableCount;
				this.#messageDigests.length = stableCount;
				this.#rescanImages();
			}
		}

		for (let i = this.#lastSyncCount; i < normalizedMessages.length; i++) {
			const msg = normalizedMessages[i]!;
			this.log.append(msg);
			this.#messageDigests.push(this.#messageDigest(msg));
			if (!this.#hasImages && messageHasImages(msg)) this.#hasImages = true;
		}
		this.#lastSyncCount = normalizedMessages.length;
	}

	/** Reset prefix + log for a model/provider switch while mode stays active. */
	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
		this.#hasImages = false;
	}

	/** Reset the sync cursor AND clear the log. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
		this.#hasImages = false;
	}

	appendMessage(message: Message): void {
		this.log.append(message);
		if (!this.#hasImages && messageHasImages(message)) this.#hasImages = true;
	}

	replaceTailMessage(message: Message): void {
		const prev = this.log.entries().at(-1);
		this.log.replaceTail(message);
		if (prev && messageHasImages(prev) && !messageHasImages(message)) {
			this.#rescanImages();
		} else if (!this.#hasImages && messageHasImages(message)) {
			this.#hasImages = true;
		}
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext, options: BuildOptions): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
		this.#hasImages = false;
		this.prefix.build(context, options);
	}

	/** Index of the first message whose serialized bytes differ from the previously-synced log. */
	#shallowDiffers(incoming: unknown, prev: unknown, i: number): boolean {
		const a = incoming as Record<string, unknown> | null;
		const b = prev as Record<string, unknown> | null;
		if (
			!a ||
			!b ||
			a.role !== b.role ||
			a.content !== b.content ||
			(a.providerPayload ?? null) !== (b.providerPayload ?? null) ||
			(a.toolCalls ?? a.tool_calls ?? null) !== (b.toolCalls ?? b.tool_calls ?? null) ||
			(a.toolCallId ?? a.tool_call_id ?? null) !== (b.toolCallId ?? b.tool_call_id ?? null) ||
			(a.toolName ?? a.name ?? null) !== (b.toolName ?? b.name ?? null) ||
			(a.isError ?? null) !== (b.isError ?? null) ||
			(a.id ?? null) !== (b.id ?? null)
		)
			return true;
		return this.#messageDigest(incoming) !== this.#messageDigests[i];
	}
	#longestStablePrefix(normalizedMessages: readonly unknown[]): number {
		const bound = Math.min(this.#lastSyncCount, normalizedMessages.length);
		const logged = this.log.entries();
		for (let i = 0; i < bound; i++) {
			const incoming = normalizedMessages[i];
			const prev = logged[i];
			if (incoming !== prev && this.#shallowDiffers(incoming, prev, i)) return i;
		}
		return bound;
	}

	/** Deterministic digest over all provider-serialized fields so in-place rewrites are visible to {@link #longestStablePrefix}. */
	#messageDigest(msg: unknown): number {
		if (!msg || typeof msg !== "object") return 0;
		const m = msg as Record<string, unknown>;
		const payload = JSON.stringify({
			r: m.role ?? null,
			c: m.content ?? null,
			pp: m.providerPayload ?? null,
			tc: m.toolCalls ?? m.tool_calls ?? null,
			tcid: m.toolCallId ?? m.tool_call_id ?? null,
			tn: m.toolName ?? m.name ?? null,
			err: m.isError ?? null,
			id: m.id ?? null,
		});
		return Number(Bun.hash(payload)) >>> 0;
	}
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function computeFingerprint(systemPrompt: string[], tools: Tool[], options: BuildOptions): string {
	const payload = JSON.stringify({
		s: systemPrompt,
		t: tools.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
			s: t.strict,
			cf: t.customFormat,
			cw: t.customWireName,
		})),
		i: options.intentTracing,
		ex: options.exampleDialect,
		pd: options.pruneToolDescriptions,
	});
	return (Number(Bun.hash(payload)) >>> 0).toString(36);
}

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

/**
 * A frozen prefix (system prompt + tools) that produces stable byte
 * sequences across `build()` calls.
 *
 * The first `build()` snapshots the live state. Subsequent calls reuse
 * the cached copy until `invalidate()` is called or the live state's
 * fingerprint changes.
 */
export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	/** The JSON-visible structure the snapshot was built from; see {@link snapshotJson}. */
	#identity: unknown = null;
	#version = 0;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	/**
	 * Build or rebuild from live context.
	 * Returns `true` if the prefix actually changed (cache miss imminent).
	 */
	build(context: AgentContext, options: BuildOptions): boolean {
		const tools =
			normalizeTools(context.tools, options.intentTracing, options.exampleDialect, options.pruneToolDescriptions) ??
			[];
		const identity = prefixIdentity(context.systemPrompt, tools, options);
		if (this.#snapshot && matchesSnapshot(identity, this.#identity)) {
			return false;
		}
		this.#snapshot = {
			systemPrompt: context.systemPrompt.slice(),
			tools,
			fingerprint: computeFingerprint(identity),
		};
		this.#identity = snapshotJson(identity);
		this.#version++;
		return true;
	}

	/** Force rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
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

/**
 * Manages a stable prefix + append-only log for the agent loop.
 *
 * Call `build(context)` each turn to get a `Context` with stable
 * `systemPrompt` and `tools` and append-only messages. Call
 * `syncMessages(normalizedMessages)` after `convertToLlm` each
 * turn to keep the log in sync.
 *
 * Example:
 * ```
 * const mgr = new AppendOnlyContextManager();
 * const ctx = mgr.build(context);  // first call snapshots prefix
 * mgr.syncMessages(normalized);    // grow the log
 * ctx = mgr.build(context);        // subsequent calls use cache
 * ```
 */
export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	/** How many normalized messages were synced into the log as of the last sync. */
	#lastSyncCount = 0;
	/**
	 * Per-message snapshots of the synced log. Lets a deep or tail rewrite
	 * (per-turn pruning, image strip, transformContext re-render) preserve
	 * the byte-stable prefix instead of re-sending the entire conversation
	 * — keeps the provider's prompt-cache hit rate up to the divergence
	 * point on every subsequent turn. A snapshot shares the message's string
	 * leaves, so comparing an unchanged message costs one pointer check per
	 * node instead of re-serializing and re-hashing the whole transcript.
	 */
	#syncedSnapshots: unknown[] = [];

	build(context: AgentContext, options: BuildOptions): Context {
		this.prefix.build(context, options);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	/**
	 * Sync normalized (provider-level) messages into the append-only log.
	 *
	 * Three cases:
	 *
	 * 1. **Append**: same prefix, new tail → push the new entries.
	 * 2. **Compaction**: shorter array → clear the log and replay.
	 * 3. **In-place rewrite** (per-turn pruning, transformContext re-render,
	 *    image strip, etc.): find the longest byte-stable prefix between
	 *    the previously-synced messages and the new ones, drop the log
	 *    down to that prefix, then append the diverged tail. Earlier
	 *    revisions cleared the whole log on any digest change, which on
	 *    llama.cpp / local backends forced a full ~40k-token re-prefill
	 *    every turn that an extension, prune pass, or steering re-wrap
	 *    rewrote a single message (#3406). Preserving the stable prefix
	 *    lets the provider's KV cache stay warm up to the divergence
	 *    point — the model only re-prefills from the changed message on.
	 */
	syncMessages(normalizedMessages: Message[]): void {
		// Compaction (array shrunk) — every previously-synced message is gone,
		// so the log can't carry any byte-stable bytes forward.
		if (normalizedMessages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
			this.#syncedSnapshots = [];
		}

		// In-place rewrite: trim the log down to the longest byte-stable prefix
		// that both the previous sync and the new messages share. Bound it by
		// the current log length because `log.clear()` is public; direct clears
		// (advisor reset) can leave the sync cursor ahead of the physical log.
		// Anything past that point will be re-appended below with the new bytes.
		if (this.#lastSyncCount > 0) {
			const stableCount = Math.min(this.#longestStablePrefix(normalizedMessages), this.log.length);
			if (stableCount < this.#lastSyncCount) {
				this.log.truncate(stableCount);
				this.#lastSyncCount = stableCount;
				this.#syncedSnapshots.length = stableCount;
			}
		}

		// Append the diverged tail (or the full delta on a normal turn).
		for (let i = this.#lastSyncCount; i < normalizedMessages.length; i++) {
			const msg = normalizedMessages[i];
			this.log.append(msg);
			this.#syncedSnapshots.push(snapshotMessage(msg));
		}
		this.#lastSyncCount = normalizedMessages.length;
	}

	/** Reset prefix + log for a model/provider switch while mode stays active. */
	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedSnapshots = [];
	}

	/** Reset the sync cursor AND clear the log. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedSnapshots = [];
	}

	appendMessage(message: Message): void {
		this.log.append(message);
	}

	replaceTailMessage(message: Message): void {
		this.log.replaceTail(message);
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext, options: BuildOptions): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedSnapshots = [];
		this.prefix.build(context, options);
	}

	/** Index of the first message whose serialized bytes differ from the
	 * previously-synced log; equals `min(lastSyncCount, normalizedMessages.length)`
	 * when nothing diverged. */
	#longestStablePrefix(normalizedMessages: readonly unknown[]): number {
		const bound = Math.min(this.#lastSyncCount, normalizedMessages.length);
		for (let i = 0; i < bound; i++) {
			if (!matchesMessage(normalizedMessages[i], this.#syncedSnapshots[i])) {
				return i;
			}
		}
		return bound;
	}
}

/** How many provider-visible fields {@link messageField} reads. */
const MESSAGE_FIELD_COUNT = 8;

/** Every field the provider may serialize — role, content, provider-native
 * replay payloads, tool calls (both `toolCalls` and OpenAI-wire `tool_calls`),
 * tool-result ids/names/error flags (both internal camelCase and wire
 * snake_case), and assistant `id` — so an in-place rewrite of *any* of these
 * fields, at any depth, is visible to {@link #longestStablePrefix}. */
function messageField(m: Record<string, unknown>, index: number): unknown {
	switch (index) {
		case 0:
			return m.role;
		case 1:
			return m.content;
		case 2:
			return m.providerPayload;
		case 3:
			return m.toolCalls ?? m.tool_calls;
		case 4:
			return m.toolCallId ?? m.tool_call_id;
		case 5:
			return m.toolName ?? m.name;
		case 6:
			return m.isError;
		default:
			return m.id;
	}
}

/** Snapshot of a message's provider-visible fields; `null` for a non-object. */
function snapshotMessage(msg: unknown): unknown[] | null {
	if (!msg || typeof msg !== "object") return null;
	const m = msg as Record<string, unknown>;
	const fields = new Array<unknown>(MESSAGE_FIELD_COUNT);
	for (let i = 0; i < MESSAGE_FIELD_COUNT; i++) fields[i] = snapshotJson(messageField(m, i)) ?? null;
	return fields;
}

function matchesMessage(msg: unknown, snapshot: unknown): boolean {
	if (!msg || typeof msg !== "object") return snapshot === null;
	if (!Array.isArray(snapshot)) return false;
	const m = msg as Record<string, unknown>;
	for (let i = 0; i < MESSAGE_FIELD_COUNT; i++) {
		const value = jsonValue(messageField(m, i));
		if (!matchesSnapshot(value === undefined ? null : value, snapshot[i])) return false;
	}
	return true;
}

/** A plain object as `JSON.stringify` would emit it: its serialized keys in
 * emission order beside their snapshotted values. */
class ObjectSnapshot {
	constructor(
		readonly keys: string[],
		readonly values: unknown[],
	) {}
}

/** Resolve a value to what `JSON.stringify` serializes in its place: `toJSON()`
 * applied once, non-finite numbers as `null`, and `undefined` for a value it
 * omits (undefined, function, symbol). */
function jsonValue(raw: unknown): unknown {
	let value = raw;
	if (typeof value === "object" && value !== null) {
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") value = toJSON.call(value);
	}
	switch (typeof value) {
		case "number":
			return Number.isFinite(value) ? value : null;
		case "undefined":
		case "function":
		case "symbol":
			return undefined;
		default:
			return value;
	}
}

/** Copy the JSON-visible structure of `raw`. Strings are immutable and shared
 * with the source, so the copy costs one node per object or array. */
function snapshotJson(raw: unknown): unknown {
	const value = jsonValue(raw);
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		const items = new Array<unknown>(value.length);
		// JSON writes an omitted array element as `null`.
		for (let i = 0; i < value.length; i++) items[i] = snapshotJson(value[i]) ?? null;
		return items;
	}
	const keys: string[] = [];
	const values: unknown[] = [];
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = snapshotJson((value as Record<string, unknown>)[key]);
		if (child === undefined) continue;
		keys.push(key);
		values.push(child);
	}
	return new ObjectSnapshot(keys, values);
}

/** `true` when `value`, already resolved by {@link jsonValue}, serializes to the
 * same JSON bytes as the value `snapshot` was taken from. Allocates nothing. */
function matchesSnapshot(value: unknown, snapshot: unknown): boolean {
	if (value === null || typeof value !== "object") return value === snapshot;
	if (Array.isArray(value)) {
		if (!Array.isArray(snapshot) || snapshot.length !== value.length) return false;
		for (let i = 0; i < value.length; i++) {
			const item = jsonValue(value[i]);
			if (!matchesSnapshot(item === undefined ? null : item, snapshot[i])) return false;
		}
		return true;
	}
	if (!(snapshot instanceof ObjectSnapshot)) return false;
	const { keys, values } = snapshot;
	let index = 0;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = jsonValue((value as Record<string, unknown>)[key]);
		if (child === undefined) continue;
		if (index >= keys.length || keys[index] !== key || !matchesSnapshot(child, values[index])) return false;
		index++;
	}
	return index === keys.length;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Everything the stable prefix sends, in the shape its fingerprint serializes. */
function prefixIdentity(systemPrompt: readonly string[], tools: readonly Tool[], options: BuildOptions): object {
	return {
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
	};
}

function computeFingerprint(identity: object): string {
	const payload = JSON.stringify(identity);
	let hash = 0;
	for (let i = 0; i < payload.length; i++) {
		hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

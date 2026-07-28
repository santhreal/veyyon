import { formatCount, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { type BankScope, ensureBankExists } from "./bank";
import type { HindsightApi, MemoryItemInput } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	loadMentalModelsBlock,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
} from "./mental-models";
import { extractMessages } from "./transcript";

export const HINDSIGHT_RETAIN_BATCH_SIZE = 16;
export const MEMORY_RETAIN_MAX_ITEM_BYTES = 64 * 1024;
export const MEMORY_RETAIN_MAX_ITEMS = 64;
export const MEMORY_RETAIN_MAX_BYTES = 256 * 1024;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;

interface PendingRetainItem {
	content: string;
	context?: string;
	timestamp: Date;
	bytes: number;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

export interface HindsightSessionStateOptions {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	/**
	 * When set, this entry is a subagent alias that reuses the parent's bank,
	 * scope, config, client, and banksSet. Aliases skip auto-recall and
	 * auto-retain — those run on the parent only — but the recall/retain/reflect
	 * tools resolve via the alias so they persist to the same bank as the parent.
	 */
	aliasOf?: HindsightSessionState;
}

/**
 * Debounced batch queue for tool-initiated `retain` calls owned by one
 * Hindsight session state instance.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and already runs `async: true` server-side.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	#items: PendingRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#timerReady = false;
	#draining?: Promise<void>;
	#residentItems = 0;
	#residentBytes = 0;
	#closed = false;

	constructor(state: HindsightSessionState) {
		this.#state = state;
	}

	/** Pending plus in-flight items; this is the actual retained-memory high-water. */
	get depth(): number {
		return this.#residentItems;
	}

	get bytes(): number {
		return this.#residentBytes;
	}

	enqueue(content: string, context?: string): void {
		this.enqueueMany([{ content, context }]);
	}

	/**
	 * Atomically accept a tool call. Capacity is checked before timestamps or
	 * queue entries are allocated, so rejection retains none of the input.
	 */
	enqueueMany(items: ReadonlyArray<{ content: string; context?: string }>): void {
		if (this.#closed) throw new Error("Hindsight retain queue is closed.");
		if (items.length === 0) return;
		if (items.length > MEMORY_RETAIN_MAX_ITEMS) {
			throw new Error(`Hindsight retain accepts at most ${MEMORY_RETAIN_MAX_ITEMS} items per request.`);
		}

		let addedBytes = 0;
		for (const [index, item] of items.entries()) {
			const bytes = Buffer.byteLength(item.content, "utf8") + Buffer.byteLength(item.context ?? "", "utf8");
			if (bytes > MEMORY_RETAIN_MAX_ITEM_BYTES) {
				throw new Error(
					`Hindsight retain item ${index + 1} is ${formatCount("byte", bytes)}, exceeding the ${formatCount("byte", MEMORY_RETAIN_MAX_ITEM_BYTES)} per-item limit.`,
				);
			}
			addedBytes += bytes;
			if (!Number.isSafeInteger(addedBytes) || addedBytes > MEMORY_RETAIN_MAX_BYTES) {
				throw new Error(
					`Hindsight retain request exceeds the ${formatCount("byte", MEMORY_RETAIN_MAX_BYTES)} queue limit.`,
				);
			}
		}
		if (
			this.#residentItems + items.length > MEMORY_RETAIN_MAX_ITEMS ||
			this.#residentBytes + addedBytes > MEMORY_RETAIN_MAX_BYTES
		) {
			throw new Error(
				`Hindsight retain queue is full (maximum ${MEMORY_RETAIN_MAX_ITEMS} items / ${formatCount("byte", MEMORY_RETAIN_MAX_BYTES)}); retry after pending memories flush.`,
			);
		}

		const timestamp = new Date();
		for (const item of items) {
			const bytes = Buffer.byteLength(item.content, "utf8") + Buffer.byteLength(item.context ?? "", "utf8");
			this.#items.push({ ...item, timestamp, bytes });
		}
		this.#residentItems += items.length;
		this.#residentBytes += addedBytes;
		this.#scheduleDrain();
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#timerReady = false;
		}
		await this.#startDrain();
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#timerReady = false;
		}
		for (const item of this.#items) {
			this.#residentItems -= 1;
			this.#residentBytes -= item.bytes;
		}
		this.#items = [];
	}

	#scheduleDrain(): void {
		if (this.#draining) return;
		const ready = this.#items.length >= HINDSIGHT_RETAIN_BATCH_SIZE;
		if (this.#timer) {
			if (!ready || this.#timerReady) return;
			clearTimeout(this.#timer);
		}
		this.#timerReady = ready;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				this.#timerReady = false;
				void this.#startDrain().catch(() => {
					// #drainLoop already emitted one actionable notice. Scheduled
					// drains have no direct caller to receive the same error.
				});
			},
			ready ? 0 : RETAIN_FLUSH_INTERVAL_MS,
		);
		this.#timer.unref?.();
	}

	async #startDrain(): Promise<void> {
		if (this.#draining) return this.#draining;
		const draining = this.#drainLoop();
		this.#draining = draining;
		try {
			await draining;
		} finally {
			if (this.#draining === draining) this.#draining = undefined;
		}
	}

	async #drainLoop(): Promise<void> {
		while (this.#items.length > 0) {
			const items = this.#items.splice(0, HINDSIGHT_RETAIN_BATCH_SIZE);
			try {
				await this.#doFlush(items);
			} catch {
				this.#release(items);
				this.#notifyRetainFailure(items.length);
				throw new Error(
					`Memory retention failed for ${formatCount("memory", items.length)}; that batch was not retained. Retry the retain tool.`,
				);
			}
			this.#release(items);
		}
	}

	#release(items: readonly PendingRetainItem[]): void {
		for (const item of items) {
			this.#residentItems -= 1;
			this.#residentBytes -= item.bytes;
		}
	}

	async #doFlush(items: PendingRetainItem[]): Promise<void> {
		const state = this.#state;
		const sessionId = state.sessionId;
		if (state.session.getHindsightSessionState() !== state) {
			logger.warn("Hindsight retain queue: session vanished, dropping batch", {
				sessionId,
				items: items.length,
			});
			return;
		}

		await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
		const batch: MemoryItemInput[] = items.map(item => ({
			content: item.content,
			context: item.context ?? state.config.retainContext,
			metadata: { session_id: sessionId },
			tags: state.retainTags,
			timestamp: item.timestamp,
		}));
		await state.client.retainBatch(state.bankId, batch, { async: true });
		if (state.config.debug) {
			logger.debug("Hindsight retain queue: batch flushed", {
				sessionId,
				bankId: state.bankId,
				items: items.length,
			});
		}
	}

	#notifyRetainFailure(count: number): void {
		this.#state.session.emitNotice(
			"warning",
			`Memory retention failed for ${formatCount("memory", count)}; that batch was not retained. Retry the retain tool.`,
			"Hindsight",
		);
	}
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn: number;
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the cached snippet was last refreshed; gates the agent_end re-list. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight ensure+load promise. `beforeAgentStartPrompt` awaits this on
	 * the first turn so the MM block lands in the system prompt before the
	 * LLM generates, even though `start()` returns before the load completes.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	unsubscribe?: () => void;
	/**
	 * Releases the `onHindsightScopeChanged` subscription that drives live
	 * rebuilds when `hindsight.bankId` / `bankIdPrefix` / `scoping` change.
	 * Only set on primary states; aliases inherit the parent's subscription.
	 */
	unsubscribeScope?: () => void;
	/** Alias states delegate persistence config to a primary parent state. */
	aliasOf?: HindsightSessionState;
	readonly retainQueue: HindsightRetainQueue;
	readonly #unregisterProviderTextTransform: () => void;

	constructor(options: HindsightSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.bankId = options.bankId;
		this.retainTags = options.retainTags;
		this.recallTags = options.recallTags;
		this.recallTagsMatch = options.recallTagsMatch;
		this.config = options.config;
		this.session = options.session;
		this.banksSet = options.banksSet;
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.aliasOf = options.aliasOf;
		this.retainQueue = new HindsightRetainQueue(this);
		this.#unregisterProviderTextTransform = this.client.registerProviderTextTransform(text =>
			this.#transformProviderText(text),
		);
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	resetConversationTracking(): void {
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
	}

	enqueueRetain(content: string, context?: string): void {
		this.retainQueue.enqueue(content, context);
	}

	enqueueRetains(items: ReadonlyArray<{ content: string; context?: string }>): void {
		this.retainQueue.enqueueMany(items);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	#transformProviderText(text: string): string {
		try {
			return this.session.obfuscateProviderText(text);
		} catch {
			// The thrown diagnostic may contain the secret-bearing input.
			throw new Error("Hindsight confidentiality transform failed.");
		}
	}

	#transformProviderMessages(messages: HindsightMessage[]): HindsightMessage[] {
		return messages.map(message => ({
			role: this.#transformProviderText(message.role),
			content: this.#transformProviderText(message.content),
		}));
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		try {
			const response = await this.client.recall(this.bankId, query, {
				budget: this.config.recallBudget,
				maxTokens: this.config.recallMaxTokens,
				types: this.config.recallTypes.length > 0 ? this.config.recallTypes : undefined,
				tags: this.recallTags,
				tagsMatch: this.recallTagsMatch,
			});
			if (signal?.aborted) return { context: null, ok: false };
			const results = response.results ?? [];
			if (results.length === 0) return { context: null, ok: true };
			const formatted = formatMemories(results);
			const block = `<memories>\n${this.config.recallPromptPreamble}\nCurrent time: ${formatCurrentTime()} UTC\n\n${formatted}\n</memories>`;
			return { context: block, ok: true };
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Hindsight: recall failed", { bankId: this.bankId, error: String(err) });
			}
			return { context: null, ok: false };
		}
	}

	async retainSession(messages: HindsightMessage[]): Promise<void> {
		const retainedAt = new Date();
		const retainFullWindow = this.config.retainMode === "full-session";
		let target: HindsightMessage[];
		let documentId: string;

		if (retainFullWindow) {
			target = messages;
			documentId = this.sessionId;
		} else {
			const windowTurns = this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${this.sessionId}-${retainedAt.getTime()}`;
		}

		// Transform raw fields before tag stripping/framing can split a secret;
		// the client transforms the resulting payload again at physical send.
		const { transcript } = prepareRetentionTranscript(this.#transformProviderMessages(target), true);
		if (!transcript) return;

		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);
		await this.client.retain(this.bankId, transcript, {
			documentId,
			context: this.config.retainContext,
			metadata: { session_id: this.sessionId },
			tags: this.retainTags,
			timestamp: retainedAt,
			async: true,
		});
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		if (!this.config.autoRetain) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;

		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					sessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async maybeRecallOnAgentStart(): Promise<void> {
		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return;
		const messages = extractMessages(this.session.sessionManager);
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return;

		const providerMessages = this.#transformProviderMessages(messages);
		const providerLatest = this.#transformProviderText(lastUser.content);
		const query = composeRecallQuery(providerLatest, providerMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, providerLatest, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return;

		this.hasRecalledForFirstTurn = true;
		if (!context) return;

		this.lastRecallSnippet = context;
		await this.#publishVolatileContextAfter("recall");
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const providerPrompt = this.#transformProviderText(promptText);
		const latestPrompt = providerPrompt.trim();
		if (!latestPrompt) return undefined;

		const history = this.#transformProviderMessages(extractMessages(this.session.sessionManager));
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return undefined;

		this.hasRecalledForFirstTurn = true;
		if (!context) return undefined;

		this.lastRecallSnippet = context;
		return context;
	}

	async recallForCompaction(messages: HindsightMessage[]): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const providerMessages = this.#transformProviderMessages(messages);
		const providerLatest = this.#transformProviderText(lastUser.content);
		const query = composeRecallQuery(providerLatest, providerMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, providerLatest, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated);
		return context ?? undefined;
	}

	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;

		// Create/ensure the bank BEFORE the first mental-model POST so we don't
		// land `createMentalModel` against a bank the server has never seen —
		// that surfaces as a FK / 404 on Hindsight's side. `ensureBankExists`
		// is idempotent (PUT) and skips after the first call via `banksSet`.
		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);

		// Seeding is opt-in (`hindsight.mentalModelAutoSeed`). Default behaviour is
		// read-only: we surface whatever models the operator has curated on the
		// bank, but we do NOT POST to create new ones unless they explicitly
		// asked. `/memory mm seed` remains the explicit-write entry point.
		if (this.config.mentalModelAutoSeed) {
			const seeds = resolveSeedsForScope(scope, this.config.scoping);
			if (seeds.length > 0) {
				await ensureMentalModels(this.client, this.bankId, seeds, this.config.debug);
			}
		}

		await this.refreshMentalModelsSnippet();
		await this.#publishVolatileContextAfter("MM load");
	}

	async refreshMentalModelsSnippet(): Promise<void> {
		const snippet = await loadMentalModelsBlock(
			this.client,
			this.bankId,
			this.config.mentalModelMaxRenderChars,
			this.recallTags,
		);
		this.mentalModelsSnippet = snippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.aliasOf) return false;
		if (!this.config.mentalModelsEnabled) return false;
		await this.refreshMentalModelsSnippet();
		await this.#publishVolatileContextAfter("MM reload");
		return true;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_start") {
				void this.maybeRecallOnAgentStart();
			} else if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd();
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue().catch(() => {
					// The queue already emitted a warning notice for this batch.
				});
				// MM TTL refresh: re-list once we're past the cache deadline. List
				// is cheap (no reflect call); the LLM doesn't see this happen.
				if (
					this.config.mentalModelsEnabled &&
					this.mentalModelsLoadedAt !== undefined &&
					Date.now() - this.mentalModelsLoadedAt >= this.config.mentalModelRefreshIntervalMs
				) {
					void this.refreshMentalModelsSnippet().then(async () => {
						await this.#publishVolatileContextAfter("MM TTL reload");
					});
				}
			}
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeScope?.();
		this.unsubscribeScope = undefined;
		this.#unregisterProviderTextTransform();
		this.retainQueue.dispose();
	}

	/**
	 * Publish the new recall / mental-model text to the context tail.
	 *
	 * This used to rebuild the system prompt, which is the provider's cache prefix:
	 * a recall or a mental-model reload made the next request re-read the whole
	 * conversation as uncached input, and on a measured 66-turn trace those misses
	 * were about 8% of the session bill. The model reads the same text in the same
	 * place; only the cache consequence changed.
	 */
	async #publishVolatileContextAfter(reason: "recall" | "MM load" | "MM reload" | "MM TTL reload"): Promise<void> {
		try {
			await this.session.publishVolatileMemoryContext(`hindsight:${reason}`);
		} catch (err) {
			logger.debug(`Hindsight: publishing memory context after ${reason} failed`, { error: String(err) });
		}
	}
}

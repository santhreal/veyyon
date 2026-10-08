/**
 * History rewrites: the passes that shrink the recorded conversation in place.
 *
 * This is a session collaborator. It reaches the session log, the live context and the caches keyed
 * on message identity only through {@link HistoryRewritesHost}, and holds no state of its own.
 *
 * - **Stale results** ({@link HistoryRewrites.pruneStale}): every turn, older `read` results a newer
 *   read of the same file superseded, and results their tool flagged useless.
 * - **Overflow** ({@link HistoryRewrites.pruneOverflow}): at the threshold check, the oldest tool
 *   results outside the protected recent window.
 * - **Images** ({@link HistoryRewrites.dropImages}): every image block on the branch.
 * - **Shake** ({@link HistoryRewrites.shake}) and **duplicates**
 *   ({@link HistoryRewrites.dedupeRedundantToolResults}): heavy and repeated content, saved to one
 *   `artifact://` recovery file through {@link HistoryRewrites.offloadAndApply}.
 *
 * The prune, shake and dedup passes skip entries the compaction in effect summarized away and the
 * tools the plan protects. The image pass strips the whole branch, and `offloadAndApply` elides the
 * regions its caller selected. Every pass that changes an entry ends in the same epilogue: the
 * changed entries are persisted, the agent's context is rebuilt from them, and every cache keyed on
 * the old messages is dropped.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegions,
	collectRedundantToolResultRegions,
	collectShakeRegions,
	type ShakeConfig,
	type ShakeRegion,
} from "@veyyon/agent-core/compaction";
import {
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@veyyon/agent-core/compaction/pruning";
import type { ProtectedToolMatcher } from "@veyyon/agent-core/compaction/tool-protection";
import { countTokens } from "@veyyon/agent-core/tokenizer";
import type { Model } from "@veyyon/ai";
import {
	PRUNE_CACHE_WARM_SUFFIX_TOKENS,
	PRUNE_IDLE_FLUSH_MS,
} from "@veyyon/kernel/session/agent-session-compaction-policy";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { ShakeMode, ShakeResult } from "@veyyon/kernel/session/shake-types";
import type { Settings } from "../../config/settings";
import { stripImagesFromMessage } from "../messages";

/** What a prune pass reports: how many results it blanked and the tokens that freed. */
export interface PruneOutcome {
	prunedCount: number;
	tokensSaved: number;
}

/** What an elision reports, with the artifact the elided content was saved to. */
export interface ElisionOutcome {
	toolResultsDropped: number;
	blocksDropped: number;
	tokensFreed: number;
	artifactId: string | undefined;
}

/** The session log slice a rewrite reads and persists. `SessionManager` satisfies this. */
export interface HistoryRewritesStore {
	getBranch(): SessionEntry[];
	rewriteEntries(updated?: Iterable<SessionEntry>): Promise<void>;
	saveArtifact(content: string, toolType: string): Promise<string | undefined>;
}

/** What {@link HistoryRewrites} needs from the session that holds it. */
export interface HistoryRewritesHost {
	readonly sessionStore: HistoryRewritesStore;
	readonly agent: { replaceMessages(messages: AgentMessage[]): void };
	/** Read at every pass, so a settings change applies to the next one. */
	readonly settings: Pick<Settings, "getGroup">;
	/** Adds the plan the session is working from to a pass's protected tools. */
	withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T;
	model(): Model | undefined;
	/** The first entry the compaction the prompt is built from kept, if one applies to `branch`. */
	keepBoundaryId(branch: readonly SessionEntry[]): string | undefined;
	/** The context rebuilt from the session log, as the agent is primed with it. */
	rebuiltMessages(): AgentMessage[];
	resetAdvisorRuntimes(): void;
	/** Close the provider sessions that cache message identity. */
	closeCodexSessions(): void;
	/**
	 * Stop the context report reading provider usage measured before the rewrite, and re-measure the
	 * prompt snapshot of a run in flight.
	 */
	markHistoryRewritten(): void;
	/** Re-read the todo board from the branch, whose tool results a prune may have blanked. */
	syncTodos(): void;
}

export class HistoryRewrites {
	readonly #host: HistoryRewritesHost;

	constructor(host: HistoryRewritesHost) {
		this.#host = host;
	}

	/**
	 * Blank the oldest tool results outside the protect-recent window, plus any result its tool
	 * flagged useless. The threshold check runs this before comparing, so a turn this alone brings
	 * back under the trigger never pays for a summarization request.
	 */
	async pruneOverflow(): Promise<PruneOutcome | undefined> {
		const host = this.#host;
		const branchEntries = host.sessionStore.getBranch();
		const result = pruneToolOutputs(
			branchEntries,
			host.withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: host.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never rewrite the warm, already-sent prefix or entries a
				// compaction summarized away. A preserved-thinking model binds each thinking block to
				// the bytes before it, so a rewrite anywhere in the sent region also costs the
				// reasoning chain behind it: the window is held to entries whose suffix is empty.
				keepBoundaryId: host.keepBoundaryId(branchEntries),
				cacheWarmSuffixTokens: host.model()?.thinking?.prefixBinding === true ? 0 : PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) return undefined;
		await this.#commit(result.prunedEntries);
		host.syncTodos();
		return result;
	}

	/**
	 * Prune older `read` results a newer read of the same file made stale, plus results their tool
	 * flagged useless, as `compaction.supersedeReads` and `compaction.dropUseless` allow. Cheap
	 * enough for every turn: it fires only when the suffix after a candidate is small or the session
	 * has idled past the provider prompt cache.
	 *
	 * The rewrite is persisted like every other: a session file that differs from the live context
	 * makes `/fork`, `/tan` and resume rebuild a divergent prefix and miss the provider cache.
	 */
	async pruneStale(): Promise<PruneOutcome | undefined> {
		const host = this.#host;
		const { supersedeReads, dropUseless } = host.settings.getGroup("compaction");
		if (!supersedeReads && !dropUseless) return undefined;
		const branchEntries = host.sessionStore.getBranch();
		const result = pruneSupersededToolResults(
			branchEntries,
			host.withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				// The whole sent region is flushed only once the cache is cold (idle past the 1h TTL).
				keepBoundaryId: host.keepBoundaryId(branchEntries),
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
				// As in `pruneOverflow`: a prefix-bound model pays for an in-place rewrite with the
				// thinking blocks recorded after it, which the cache math cannot price, so eligibility
				// is capped instead of the tail.
				...(host.model()?.thinking?.prefixBinding === true ? { cacheWarmSuffixTokens: 0 } : {}),
			}),
		);
		if (result.prunedCount === 0) return undefined;
		await this.#commit(result.prunedEntries);
		host.syncTodos();
		return result;
	}

	/**
	 * Strip image blocks from every message and custom message on the branch. A custom message left
	 * with no content reads `[image removed]`. Returns `{ removed: 0 }` without a rewrite when the
	 * branch holds no image.
	 */
	async dropImages(): Promise<{ removed: number }> {
		const branchEntries = this.#host.sessionStore.getBranch();
		let removed = 0;
		const updated: SessionEntry[] = [];
		for (const entry of branchEntries) {
			if (entry.type === "message") {
				const stripped = stripImagesFromMessage(entry.message);
				if (stripped > 0) {
					removed += stripped;
					updated.push(entry);
				}
				continue;
			}
			if (entry.type === "custom_message" && typeof entry.content !== "string") {
				const kept: typeof entry.content = [];
				let dropped = 0;
				for (const part of entry.content) {
					if (part.type === "image") dropped++;
					else kept.push(part);
				}
				if (dropped > 0) {
					if (kept.length === 0) kept.push({ type: "text", text: "[image removed]" });
					entry.content = kept;
					removed += dropped;
					updated.push(entry);
				}
			}
		}
		if (removed === 0) return { removed: 0 };
		await this.#commit(updated);
		return { removed };
	}

	/**
	 * Reduce context by dropping heavy content. `images` drops images; `elide` replaces large tool
	 * results, large fenced or XML blocks, and tool results byte-identical to a newer one with
	 * placeholders that link the saved original. Zero counts when nothing is eligible.
	 */
	async shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}
		const host = this.#host;
		const branchEntries = host.sessionStore.getBranch();
		const config = host.withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),
			keepBoundaryId: host.keepBoundaryId(branchEntries),
		});
		// The heavy pass takes large results and blocks under the size, recency and savings limits.
		// The redundancy pass takes any earlier result byte-identical to a newer one however recent,
		// since a duplicate holds nothing unique. They overlap only on a whole tool result, which the
		// heavy pass already elides.
		const heavyRegions = collectShakeRegions(branchEntries, config);
		const heavyToolResults = new Set<ShakeRegion["entry"]>();
		for (const region of heavyRegions) if (region.kind === "toolResult") heavyToolResults.add(region.entry);
		const regions = heavyRegions.concat(
			collectRedundantToolResultRegions(branchEntries, config).filter(region => !heavyToolResults.has(region.entry)),
		);
		if (regions.length === 0) return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
		const applied = await this.offloadAndApply(regions);
		return {
			mode,
			toolResultsDropped: applied.toolResultsDropped,
			blocksDropped: applied.blocksDropped,
			tokensFreed: applied.tokensFreed,
			artifactId: applied.artifactId,
		};
	}

	/**
	 * Elide earlier tool results byte-identical to a newer one. Lossless and model-free: the newest
	 * copy stays live and every elided copy is recoverable from the artifact, so any compaction
	 * strategy may run it. Zero counts when nothing is redundant.
	 */
	async dedupeRedundantToolResults(): Promise<{
		toolResultsDropped: number;
		tokensFreed: number;
		artifactId?: string;
	}> {
		const host = this.#host;
		const branchEntries = host.sessionStore.getBranch();
		const config = host.withPlanProtection({
			...AGGRESSIVE_SHAKE_CONFIG,
			keepBoundaryId: host.keepBoundaryId(branchEntries),
		});
		const regions = collectRedundantToolResultRegions(branchEntries, config);
		if (regions.length === 0) return { toolResultsDropped: 0, tokensFreed: 0 };
		const applied = await this.offloadAndApply(regions);
		return {
			toolResultsDropped: applied.toolResultsDropped,
			tokensFreed: applied.tokensFreed,
			artifactId: applied.artifactId,
		};
	}

	/**
	 * Save `regions` to one recovery artifact, splice their placeholders in place, and commit the
	 * rewrite. `regions` is non-empty.
	 */
	async offloadAndApply(regions: ShakeRegion[]): Promise<ElisionOutcome> {
		const artifactId = await this.#saveArtifact(regions);
		let toolResultsDropped = 0;
		let blocksDropped = 0;
		let originalTokens = 0;
		let replacementTokens = 0;
		const items = regions.map((region, index) => {
			if (region.kind === "toolResult") toolResultsDropped++;
			else blocksDropped++;
			originalTokens += region.tokens;
			const replacement = shakeElidePlaceholder(region, index, artifactId);
			if (replacement.length > 0) replacementTokens += countTokens(replacement);
			return { region, replacement };
		});
		applyShakeRegions(items);
		await this.#commit(regions.map(region => region.entry));
		return {
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	/**
	 * The epilogue of every in-place rewrite: persist the new shape, rebuild the agent's context from
	 * it, reset the advisor runtimes, close the provider sessions that cache message identity, and
	 * mark the context report.
	 *
	 * Provider usage from this turn was computed over a prompt the rewrite shortened. Without the
	 * mark, the report counts the removed bytes until a response that describes the new shape
	 * arrives, and the compaction decision, which takes the larger of the provider figure and a local
	 * estimate, never skips a summarization that the rewrite made unnecessary.
	 */
	async #commit(updated: Iterable<SessionEntry>): Promise<void> {
		const host = this.#host;
		await host.sessionStore.rewriteEntries(updated);
		host.agent.replaceMessages(host.rebuiltMessages());
		host.resetAdvisorRuntimes();
		host.closeCodexSessions();
		host.markHistoryRewritten();
	}

	/**
	 * Concatenate the regions' original contents into one session artifact, readable as
	 * `artifact://<id>`. `undefined` when the session is not persisted or the write fails; the
	 * placeholders then link nothing.
	 */
	async #saveArtifact(regions: ShakeRegion[]): Promise<string | undefined> {
		const parts: string[] = [];
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
		}
		try {
			return await this.#host.sessionStore.saveArtifact(parts.join("\n"), "shake");
		} catch {
			return undefined;
		}
	}
}

/**
 * The marker that replaces one region's content. A truncation region is the middle of a text whose
 * head and tail survive, so its marker states the text continues; every other region's content is
 * replaced entirely.
 */
function shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
	const truncated = region.kind === "block" && region.truncation === true;
	const verb = truncated ? "truncated" : "shaken";
	const marker = artifactId
		? `[${verb} ~${region.tokens} tokens; recover: artifact://${artifactId} (region ${index + 1})]`
		: `[${verb} ~${region.tokens} tokens]`;
	return truncated ? `\n${marker}\n` : marker;
}

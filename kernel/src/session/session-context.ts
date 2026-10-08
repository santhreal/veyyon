import type { AgentMessage } from "@veyyon/agent-core";
// The reader that owns "which entry does a compaction's keep marker name": it is the
// only place the keep-nothing sentinel, an ordinary id and an id that resolves to
// nothing are told apart, and the prune and shake passes already read the field
// through it. `entries.ts` is a leaf beside the two above.
import { KEEP_NOTHING_ENTRY_ID, resolveCompactionBoundaryIndex } from "@veyyon/agent-core/compaction/entries";
// Same reasoning as the line above: the zero-import leaf that owns the predicate,
// not the compaction barrel. `legacy-provider-native.ts` imports nothing, so this
// edge adds exactly one module to every graph this file is on.
import { hasLegacyProviderNativeCompaction } from "@veyyon/agent-core/compaction/legacy-provider-native";
// The owner, not the `compaction` subpath barrel. That barrel re-exports the compaction ENGINE, which
// imports the `@veyyon/ai` barrel to summarize a conversation; this module is a self-contained reader for a
// retired archive format and imports nothing at all. The edge cost 238 modules, and it was on the graph of
// `internal-urls/index.ts` (the URL router) and `tools/fs/read.ts` through `session/session-loader.ts`.
import { legacyArchiveSourceText } from "@veyyon/agent-core/compaction/legacy-snapcompact-archive";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@veyyon/agent-core/compaction/messages";
// The remote-compaction entry reader is a leaf beside the legacy one: it turns a
// server-side compaction's stored window back into the provider payload the
// Responses-family request builder replays, and names who compacted for display.
import {
	remoteCompactionAttribution,
	remoteCompactionProviderPayload,
	remoteCompactionReplayableBy,
} from "@veyyon/agent-core/compaction/remote-compaction-entry";
import type { TextContent } from "@veyyon/ai";
// From the module that DEFINES the coercion, not the barrel that re-exports it.
// `@veyyon/ai/types` is 5 modules against the barrel's 346, and this file is on
// `session/session-manager.ts`'s path, which ~200 test files import.
import { coerceServiceTierByFamily, type ServiceTierByFamily } from "@veyyon/ai/types";
// The owner, not the `@veyyon/utils` barrel: 2 modules against 74, and this file is on
// the graph of the URL router and the read tool.
import * as logger from "@veyyon/utils/logger";
import { isCustomMessageContent, normalizeCustomMessagePayload } from "./custom-message-payload";
import { type CompactionEntry, EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel?: string;
	/** Configured thinking selector (`"auto"` or a concrete level) from the latest change. */
	configuredThinkingLevel?: string;
	serviceTier?: ServiceTierByFamily;
	/** Model roles: { default: "provider/modelId", small: "provider/modelId", ... } */
	models: Record<string, string>;
	/** Names of TTSR rules that have been injected this session */
	injectedTtsrRules: string[];
	/** MCP tool names selected through discovery for this session branch. */
	selectedMCPToolNames: string[];
	/** Whether this branch contains an explicit persisted MCP selection entry. */
	hasPersistedMCPToolSelection: boolean;
	/** Active mode (e.g. "plan") or "none" if no special mode is active */
	mode: string;
	/** Mode-specific data from the last mode_change entry */
	modeData?: Record<string, unknown>;
	/**
	 * Array parallel to messages, indicating which assistant turns should
	 * have their prompt-cache misses suppressed/explained (because a model,
	 * compaction, or plan-mode transition directly preceded them).
	 * Only populated in transcript mode.
	 */
	cacheMissExplainedAt?: boolean[];
}

/** Lists session model strings to try when restoring, in fallback order. */
export function getRestorableSessionModels(
	models: Readonly<Record<string, string>>,
	lastModelChangeRole: string | undefined,
): string[] {
	const defaultModel = models.default;
	if (
		!lastModelChangeRole ||
		lastModelChangeRole === "default" ||
		lastModelChangeRole === EPHEMERAL_MODEL_CHANGE_ROLE
	) {
		return defaultModel ? [defaultModel] : [];
	}

	const roleModel = models[lastModelChangeRole];
	if (!roleModel) return defaultModel ? [defaultModel] : [];
	if (!defaultModel || roleModel === defaultModel) return [roleModel];
	return [roleModel, defaultModel];
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/**
 * Whether a compaction entry can stand in for the span it hid when the branch
 * runs on `activeProvider`: a window that provider can replay, or real summary
 * text. A server-side entry carries no readable summary by construction, and a
 * legacy provider-native entry carries only a placeholder sentence, so neither
 * stands in for anything once its provider cannot read it.
 */
function isUsableCompaction(entry: CompactionEntry, activeProvider: string | undefined): boolean {
	if (hasLegacyProviderNativeCompaction(entry.preserveData)) return false;
	return remoteCompactionReplayableBy(entry.preserveData, activeProvider) || entry.summary.trim().length > 0;
}

/**
 * The compaction a context rebuild applies to `path` on `activeProvider` (the
 * `provider` half of the branch's default model): the NEWEST entry that can stand
 * in for the span it hid, or null when none can.
 *
 * Newest usable, not newest. A server-side compaction minted by one provider is
 * unreadable to the next, and treating the latest entry as the only candidate made
 * a provider switch re-expand the branch from its first entry, although an earlier
 * local summary covered all but the tail since it. That is the difference between
 * resuming from the last readable summary and resending the whole session. This is
 * the read-side twin of the walk in `prepareCompaction`, which already builds on
 * the newest reusable entry rather than the newest entry.
 */
export function getEffectiveCompactionEntry(
	path: readonly SessionEntry[],
	activeProvider: string | undefined,
): CompactionEntry | null {
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry.type === "compaction" && isUsableCompaction(entry, activeProvider)) return entry;
	}
	return null;
}

export interface BuildSessionContextOptions {
	/**
	 * Build the display transcript instead of the LLM context. By default this
	 * preserves every path entry with compactions inline; set
	 * `collapseCompactedHistory` for the live TUI surface to render only the
	 * latest compacted tail.
	 */
	transcript?: boolean;
	/** In transcript mode, elide entries replaced by the latest compaction. */
	collapseCompactedHistory?: boolean;
	/**
	 * Transcript mode only: keep `toolCall` blocks that have no matching
	 * `toolResult` on the path instead of stripping them. Pass this when the
	 * session is mid-turn (a tool is still executing, its result not yet
	 * persisted) so the rebuilt transcript renders the in-flight call as
	 * pending; without it a focus/unfocus or overlay-close rebuild silently
	 * hides the call the agent is still waiting on.
	 */
	keepDanglingToolCalls?: boolean;
}

/**
 * Display-only marker set on transcript assistant messages whose dangling
 * `toolCall` blocks were stripped (no paired result on the resolved path —
 * failed/retried turns, results on sibling branches). The TUI renders a
 * placeholder row from it so the turn's activity never silently vanishes.
 */
export interface StrippedToolCallsMarker {
	strippedToolCalls?: number;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
/**
 * Re-attach the plaintext source of a legacy image-archive compaction as a
 * single text block, so an old session whose compaction persisted a frame
 * archive keeps showing its archived history after every context rebuild. The
 * removed engine also stored the full source under `archive.text`; the frames
 * were only an image duplicate of it, so recovering the text is lossless. New
 * sessions never write such an archive, so this returns `undefined` for them.
 */
function legacyArchiveBlocksForContext(
	preserveData: Record<string, unknown> | undefined,
	options: BuildSessionContextOptions | undefined,
): TextContent[] | undefined {
	if (options?.transcript && options.collapseCompactedHistory) return undefined;
	const text = legacyArchiveSourceText(preserveData);
	if (!text) return undefined;
	return [{ type: "text", text: `Recovered archived history from a prior compaction:\n\n${text}` }];
}

function emptySessionContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

/** Where a branch walk finds an entry by id: `SessionEntryIndex`, or a `Map` built for one walk. */
export interface SessionEntryLookup {
	get(id: string): SessionEntry | undefined;
}

export function walkBranchPath(byId: SessionEntryLookup, leaf?: SessionEntry): SessionEntry[] {
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = leaf;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

/**
 * The entry a session context is built up to. A named leaf that resolves to
 * nothing falls back to the tail, the same as an absent one: an id can outlive
 * the entry it named once a prune or a compaction rewrites the file, and a
 * resumed session must reopen on its last entry rather than on an empty
 * conversation. `leafId === null` is the explicit "before the first entry"
 * position and has no leaf.
 */
export function resolveContextLeaf(
	entries: readonly SessionEntry[],
	leafId: string | null | undefined,
	byId: SessionEntryLookup,
): SessionEntry | undefined {
	if (leafId === null) return undefined;
	return (leafId ? byId.get(leafId) : undefined) ?? entries[entries.length - 1];
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: SessionEntryLookup,
	options?: BuildSessionContextOptions,
): SessionContext {
	if (leafId === null) return emptySessionContext();

	if (!byId) {
		const built = new Map<string, SessionEntry>();
		for (const entry of entries) built.set(entry.id, entry);
		byId = built;
	}

	const leaf = resolveContextLeaf(entries, leafId, byId);
	if (!leaf) return emptySessionContext();

	return buildSessionContextFromPath(walkBranchPath(byId, leaf), options);
}

/** What a branch's entries set, read in one pass: the latest value of each setting, and the newest compaction. */
interface BranchSettings {
	thinkingLevel: string | undefined;
	configuredThinkingLevel: string | undefined;
	serviceTier: ServiceTierByFamily | undefined;
	models: Record<string, string>;
	/**
	 * Newest compaction on the path that is not a legacy provider-native entry. The rebuild applies
	 * the newest USABLE one (see getEffectiveCompactionEntry); this one is used only when none is
	 * usable, so a collapsed transcript still shows where the unreadable compaction fired.
	 */
	latestCompaction: CompactionEntry | null;
	injectedTtsrRules: Set<string>;
	selectedMCPToolNames: string[];
	hasPersistedMCPToolSelection: boolean;
	mode: string;
	modeData: Record<string, unknown> | undefined;
}

/**
 * Entry kinds {@link readBranchSettings} reads on every context build, wherever they sit on the
 * branch. A session keeps their payloads in memory when it moves compacted history to disk.
 */
export const BRANCH_SETTINGS_ENTRY_TYPES: ReadonlySet<SessionEntry["type"]> = new Set<SessionEntry["type"]>([
	"thinking_level_change",
	"model_change",
	"service_tier_change",
	"compaction",
	"ttsr_injection",
	"mcp_tool_selection",
	"mode_change",
]);

function readBranchSettings(path: readonly SessionEntry[]): BranchSettings {
	const settings: BranchSettings = {
		thinkingLevel: "off",
		configuredThinkingLevel: undefined,
		serviceTier: undefined,
		models: {},
		latestCompaction: null,
		injectedTtsrRules: new Set<string>(),
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
		modeData: undefined,
	};
	// Once an explicit `model_change` with role="default" is on the path, an assistant message no
	// longer names the default model: temporary fallbacks (retry fallback, context promotion) and
	// server-side model downgrades both produce assistant messages tagged with the wrong model id,
	// which clobbered the user's pick on resume (issue #849).
	let hasExplicitDefaultModel = false;
	for (const entry of path) {
		if (!BRANCH_SETTINGS_ENTRY_TYPES.has(entry.type)) continue;
		switch (entry.type) {
			case "thinking_level_change":
				settings.thinkingLevel = entry.thinkingLevel ?? "off";
				settings.configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
				break;
			case "model_change":
				// New format: { model: "provider/id", role?: string }
				if (entry.model) {
					const role = entry.role ?? "default";
					settings.models[role] = entry.model;
					if (role === "default") hasExplicitDefaultModel = true;
				}
				break;
			case "service_tier_change":
				settings.serviceTier = coerceServiceTierByFamily(entry.serviceTier);
				break;
			case "compaction":
				// A compaction written by the removed provider-native remote path is NOT an effective
				// compaction for this rebuild. Its `summary` is the fixed placeholder "Remote compaction
				// preserved provider-native history for this session." and carries no task content: the
				// real history lived in the opaque `preserveData` blob, which only the provider could read
				// and which is never replayed. Honoring its `firstKeptEntryId` dropped every entry before
				// the cut from context on every rebuild, resume and fork.
				//
				// The raw entries are still on the branch, so skipping the entry re-emits them verbatim,
				// and the next compaction summarizes them locally. `hasReusableSummary` in
				// `prepareCompaction` makes the same ruling. An earlier real compaction on the branch, if
				// any, still wins and still applies its own cut.
				if (!hasLegacyProviderNativeCompaction(entry.preserveData)) settings.latestCompaction = entry;
				break;
			case "ttsr_injection":
				for (const ruleName of entry.injectedRules) settings.injectedTtsrRules.add(ruleName);
				break;
			case "mcp_tool_selection":
				settings.selectedMCPToolNames = entry.selectedToolNames.slice();
				settings.hasPersistedMCPToolSelection = true;
				break;
			case "mode_change":
				settings.mode = entry.mode;
				settings.modeData = entry.data;
				break;
		}
	}
	// Legacy fallback for sessions written before `model_change`: the newest assistant message on
	// the path names the default model. Read from the end, so a branch whose live tail holds an
	// assistant turn never reads a message of its compacted history, which may be on disk rather
	// than in memory (see ColdEntryPayloads).
	if (!hasExplicitDefaultModel) {
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i]!;
			if (entry.type === "message" && entry.message.role === "assistant") {
				settings.models.default = `${entry.message.provider}/${entry.message.model}`;
				break;
			}
		}
	}
	return settings;
}

/**
 * Index on `path` of the first entry a context built from it can send: the keep boundary of the
 * newest compaction that is not a legacy provider-native one, or 0 when there is none. Entries
 * before it are read by the whole-history transcript, a tree view or an export, and by a context
 * whose newest compaction the active provider cannot use.
 */
export function compactedHistoryEnd(path: readonly SessionEntry[]): number {
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i]!;
		if (entry.type !== "compaction" || hasLegacyProviderNativeCompaction(entry.preserveData)) continue;
		return resolveCompactionBoundaryIndex(path, entry.firstKeptEntryId);
	}
	return 0;
}

/** The summary message a compaction entry renders as, with any legacy archived history re-attached as text. */
function compactionSummaryMessage(
	entry: CompactionEntry,
	options: BuildSessionContextOptions | undefined,
): AgentMessage {
	return createCompactionSummaryMessage(
		entry.summary,
		entry.tokensBefore,
		entry.timestamp,
		entry.shortSummary,
		remoteCompactionProviderPayload(entry.preserveData),
		undefined,
		legacyArchiveBlocksForContext(entry.preserveData, options),
		entry.warning,
		remoteCompactionAttribution(entry.preserveData),
	);
}

/**
 * The messages a context rebuild emits, in order, and in transcript mode whether each one's prompt
 * cache miss is explained by a model, compaction or plan-mode transition directly before it.
 */
class ContextMessages {
	readonly messages: AgentMessage[] = [];
	readonly cacheMissExplainedAt: boolean[] = [];
	readonly #transcript: boolean;
	#pendingReset = false;
	#currentMode = "none";
	#lastAssistantModel: string | undefined;
	/**
	 * The calls of a recovered assistant turn dropped from the model's context, whose results go with
	 * it. A retried transport death pairs every call it never ran with a placeholder result, and those
	 * placeholders outlive the turn on disk: replaying them alone handed a resumed session tool results
	 * whose `tool_use` is no longer in the context, one of them carrying the batch ledger that asks the
	 * model to reissue calls the retry had already reissued and run.
	 *
	 * Only the run of results IMMEDIATELY after the dropped turn goes with it. The retried turn can
	 * reissue the same call ids, so a set held for the rest of the walk would take the replay's real
	 * results as well and hand the model a `tool_use` with no answer.
	 */
	#orphanedCallIds: Set<string> | undefined;

	constructor(transcript: boolean) {
		this.#transcript = transcript;
	}

	/** Note an entry that makes the next assistant turn's cache miss expected. */
	trackReset(entry: SessionEntry): void {
		if (entry.type === "compaction" || entry.type === "model_change") {
			this.#pendingReset = true;
		} else if (entry.type === "mode_change") {
			if ((entry.mode === "plan") !== (this.#currentMode === "plan")) this.#pendingReset = true;
			this.#currentMode = entry.mode;
		}
	}

	push(message: AgentMessage): void {
		this.messages.push(message);
		if (!this.#transcript) return;
		if (message.role !== "assistant") {
			this.cacheMissExplainedAt.push(false);
			return;
		}
		const model = `${message.provider}/${message.model}`;
		const modelChanged = this.#lastAssistantModel !== undefined && this.#lastAssistantModel !== model;
		this.#lastAssistantModel = model;
		this.cacheMissExplainedAt.push(this.#pendingReset || modelChanged);
		this.#pendingReset = false;
	}

	/** Emit the message `entry` records, if it records one the context carries. */
	append(entry: SessionEntry): void {
		this.trackReset(entry);
		if (entry.type === "message") {
			this.#appendMessage(entry.message);
		} else if (entry.type === "custom_message") {
			if (!isCustomMessageContent(entry.content)) return;
			const normalized = normalizeCustomMessagePayload(entry);
			const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
			this.push(
				createCustomMessage(
					normalized.customType,
					normalized.content,
					normalized.display,
					normalized.details,
					entry.timestamp,
					attribution,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			this.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	}

	#appendMessage(message: AgentMessage): void {
		if (!this.#transcript && message.role === "assistant" && message.retryRecovery?.status === "recovered") {
			this.#orphanedCallIds = new Set<string>();
			for (const block of message.content) {
				if (block.type === "toolCall") this.#orphanedCallIds.add(block.id);
			}
			return;
		}
		if (this.#orphanedCallIds !== undefined) {
			if (message.role === "toolResult" && this.#orphanedCallIds.delete(message.toolCallId)) return;
			this.#orphanedCallIds = undefined;
		}
		this.push(message);
	}
}

/**
 * Display transcript: every entry in chronological order. Compactions do not erase prior history
 * here: each renders inline (as a divider in the TUI) at the point it fired, with any legacy archived
 * history re-attached as text so the component can report it.
 */
function emitWholeTranscript(
	path: readonly SessionEntry[],
	out: ContextMessages,
	options: BuildSessionContextOptions | undefined,
): void {
	for (const entry of path) {
		if (entry.type === "compaction") {
			out.trackReset(entry);
			out.push(compactionSummaryMessage(entry, options));
		} else {
			out.append(entry);
		}
	}
}

/**
 * Emit `path` behind `compaction`: its summary, the pre-compaction entries it kept, and every entry
 * after it.
 *
 * A remote compaction entry carries the provider's window and NO readable summary: the window is the
 * compacted context, and billing a second model to paraphrase the same span is the cost that path
 * used to pay (see remote-compaction.ts). So an entry is only usable as a compaction when it can
 * stand in for the span it hid: a window the active provider can replay, or real summary text.
 * `compaction` is the newest such entry whenever one exists, and is unusable only when none on the
 * branch is. Treating an unusable entry as a compaction would drop the span from context entirely
 * while its messages sit on disk untouched, so the branch is re-expanded instead, and the next
 * compaction on the new provider summarizes it locally (see hasReusableSummary in compaction.ts).
 */
function emitBehindCompaction(
	path: readonly SessionEntry[],
	compaction: CompactionEntry,
	activeProvider: string | undefined,
	out: ContextMessages,
	options: BuildSessionContextOptions | undefined,
): void {
	const usableCompaction = isUsableCompaction(compaction, activeProvider);
	const summary = compactionSummaryMessage(compaction, options);
	// Agent context: summary first, so the model reads the compacted context before recent messages.
	if (!options?.transcript && usableCompaction) out.push(summary);

	// `compaction` is one of `path`'s own entries and sits near the tail, so an identity search from
	// the end finds it without walking the summarized history in front of it.
	const compactionIdx = path.lastIndexOf(compaction);
	for (let i = keptEntriesFrom(path, compaction, usableCompaction); i < compactionIdx; i++) out.append(path[i]);

	// Display transcript: the summary goes at the chronological compaction point (after kept messages,
	// before post-compaction) so it stays in the live region where Ctrl+O can expand it. Reset tracking
	// fires here so the first post-compaction assistant turn, not a kept pre-compaction one, is marked
	// as a cache miss.
	if (options?.transcript) {
		out.trackReset(compaction);
		out.push(summary);
	}
	for (let i = compactionIdx + 1; i < path.length; i++) out.append(path[i]);
}

/**
 * Where the pre-compaction entries `compaction` kept begin on `path`: its keep marker, resolved
 * through the reader every other pass uses rather than by a private walk.
 *
 * An ordinary id keeps from that entry. `KEEP_NOTHING_ENTRY_ID` names no entry at all, which is how a
 * compaction of one unbreakable oversized turn says it kept nothing. An id that named a real entry
 * which is no longer on the path is damage: the loader drops a record it cannot parse rather than
 * refusing the session, and the v1 migration left the field unset whenever the old numeric index
 * pointed at the header. A walk that only asks "have I seen the id yet" answered "keep nothing" to all
 * three, so one unreadable line silently removed every kept turn from the model's context and from
 * the transcript while the summary made the session look whole. The prune and shake passes read the
 * same field through the shared reader, which treats an id that resolves to nothing as "the whole
 * branch is live". Damage now costs only the record that was lost: the span is re-expanded, which
 * overlaps the summary by a few turns and loses nothing.
 */
function keptEntriesFrom(path: readonly SessionEntry[], compaction: CompactionEntry, usable: boolean): number {
	if (!usable) return 0;
	const keptFrom = resolveCompactionBoundaryIndex(path, compaction.firstKeptEntryId);
	if (
		compaction.firstKeptEntryId !== KEEP_NOTHING_ENTRY_ID &&
		keptFrom === 0 &&
		path[0]?.id !== compaction.firstKeptEntryId
	) {
		logger.warn("Compaction keep marker names no entry on the branch; re-expanding the pre-compaction span", {
			compactionId: compaction.id,
			firstKeptEntryId: compaction.firstKeptEntryId,
		});
	}
	return keptFrom;
}

/**
 * `message` without its `toolCall` blocks that no result on the path answers, the same message when
 * it has none, or `undefined` when nothing is left of it outside the transcript.
 *
 * A rewritten turn also has its protected reasoning neutralized: a *modified* assistant turn that
 * still carries signed `thinking`/`redacted_thinking` is rejected by Anthropic ("thinking blocks in
 * the latest assistant message cannot be modified"), and signed thinking replayed out of its original
 * turn shape can also fail signature validation (this bites the handoff/branch-summary request). So
 * `redactedThinking` (encrypted, no plaintext to keep) is dropped and `thinking` signatures are
 * cleared, which makes the provider encoder downgrade them to plain text (verified accepted by the
 * live API): the visible reasoning stays and the immutability/invalid-signature hazard goes.
 */
function withoutDanglingToolCalls(
	message: AgentMessage,
	pairedToolResultIds: ReadonlySet<string>,
	transcript: boolean,
): AgentMessage | undefined {
	if (message.role !== "assistant") return message;
	let strippedToolCalls = 0;
	for (const block of message.content) {
		if (block.type === "toolCall" && !pairedToolResultIds.has(block.id)) strippedToolCalls++;
	}
	if (strippedToolCalls === 0) return message;
	const normalized = message.content
		.filter(
			block =>
				!(block.type === "toolCall" && !pairedToolResultIds.has(block.id)) && block.type !== "redactedThinking",
		)
		.map(block =>
			block.type === "thinking" && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block,
		);
	if (normalized.length === 0 && !transcript) return undefined;
	const rewritten = { ...message, content: normalized };
	// Display transcript: the turn stays (even content-less), marked with how many calls were dropped,
	// so the TUI renders a placeholder row instead of silently erasing the turn's activity.
	if (transcript) (rewritten as AgentMessage & StrippedToolCallsMarker).strippedToolCalls = strippedToolCalls;
	return rewritten;
}

/**
 * Strip dangling tool_use blocks (a tool_use with no matching tool_result on the resolved leaf→root
 * path) from ANY assistant turn, not just the trailing one.
 *
 * This happens whenever the leaf (or a branch point) lands such that an assistant turn's tool results
 * are off the selected path: its result children live on a sibling branch, or it is the leaf itself
 * (results are children below it). Left in place, `transformMessages` fabricates one synthetic
 * "aborted"/"No result provided" result per dangling call, which render as phantom failed calls and
 * re-inject the failed batch into the model's context: the rewind/restore loop.
 *
 * A turn is dropped only outside the transcript, so `cacheMissExplainedAt`, which only the transcript
 * fills, stays parallel to the messages.
 */
function stripDanglingToolCalls(messages: AgentMessage[], transcript: boolean): void {
	const pairedToolResultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
	}
	let kept = 0;
	for (const message of messages) {
		const stripped = withoutDanglingToolCalls(message, pairedToolResultIds, transcript);
		if (stripped !== undefined) messages[kept++] = stripped;
	}
	messages.length = kept;
}

/**
 * Build the session context from an already-resolved root→leaf `path`, as
 * {@link walkBranchPath} returns it. A caller that holds the active branch
 * (the session manager's index) skips the leaf→root walk, which is linear in
 * the length of the session and dominated resume on long sessions when every
 * startup reader repeated it.
 */
export function buildSessionContextFromPath(
	path: readonly SessionEntry[],
	options?: BuildSessionContextOptions,
): SessionContext {
	const settings = readBranchSettings(path);
	const activeProvider = settings.models.default?.split("/")[0];
	const compaction = getEffectiveCompactionEntry(path, activeProvider) ?? settings.latestCompaction;
	const transcript = options?.transcript === true;
	const out = new ContextMessages(transcript);
	if (transcript && !options?.collapseCompactedHistory) emitWholeTranscript(path, out, options);
	else if (compaction) emitBehindCompaction(path, compaction, activeProvider, out, options);
	else for (const entry of path) out.append(entry);

	// Live turns only qualify mid-turn: a transcript rebuild while the tool still executes sees the
	// persisted assistant turn without its result. Those callers pass `keepDanglingToolCalls` so the
	// in-flight call stays visible as a pending block instead of vanishing from the chat.
	if (!(transcript && options?.keepDanglingToolCalls === true)) stripDanglingToolCalls(out.messages, transcript);

	return {
		messages: out.messages,
		cacheMissExplainedAt: transcript ? out.cacheMissExplainedAt : undefined,
		thinkingLevel: settings.thinkingLevel,
		configuredThinkingLevel: settings.configuredThinkingLevel,
		serviceTier: settings.serviceTier,
		models: settings.models,
		injectedTtsrRules: Array.from(settings.injectedTtsrRules),
		selectedMCPToolNames: settings.selectedMCPToolNames,
		hasPersistedMCPToolSelection: settings.hasPersistedMCPToolSelection,
		mode: settings.mode,
		modeData: settings.modeData,
	};
}

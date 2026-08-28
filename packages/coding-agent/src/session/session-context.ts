import type { AgentMessage } from "@veyyon/agent-core";
// The reader that owns "which entry does a compaction's keep marker name": it is the only place the keep-nothing sentinel, an ordinary id and an id that resolves to
import { KEEP_NOTHING_ENTRY_ID, resolveCompactionBoundaryIndex } from "@veyyon/agent-core/compaction/entries";
// Same reasoning as the line above: the zero-import leaf that owns the predicate,
// not the compaction barrel. `legacy-provider-native.ts` imports nothing, so this
// edge adds exactly one module to every graph this file is on.
import { hasLegacyProviderNativeCompaction } from "@veyyon/agent-core/compaction/legacy-provider-native";
// The owner, not the `compaction` subpath barrel. That barrel re-exports the compaction ENGINE, which imports the `@veyyon/ai` barrel to summarize a conversation; this module is a self-contained reader for a
import { legacyArchiveSourceText } from "@veyyon/agent-core/compaction/legacy-snapcompact-archive";
// The remote-compaction entry reader is a leaf beside the legacy one: it turns a
// server-side compaction's stored window back into the provider payload the
// Responses-family request builder replays, and names who compacted for display.
import {
	getRemoteCompactionPreserveData,
	remoteCompactionAttribution,
	remoteCompactionProviderPayload,
} from "@veyyon/agent-core/compaction/remote-compaction-entry";
import type { TextContent } from "@veyyon/ai";
// From the module that DEFINES the coercion, not the barrel that re-exports it.
// `@veyyon/ai/types` is 5 modules against the barrel's 346, and this file is on
// `session/session-manager.ts`'s path, which ~200 test files import.
import { coerceServiceTierByFamily, type ServiceTierByFamily } from "@veyyon/ai/types";
// The owner, not the `@veyyon/utils` barrel: 2 modules against 74, and this file is on
// the graph of the URL router and the read tool.
import * as logger from "@veyyon/utils/logger";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	isCustomMessageContent,
	normalizeCustomMessagePayload,
} from "./messages";
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
	/** Array parallel to messages, indicating which assistant turns should have their prompt-cache misses suppressed/explained (because a model, */
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

export interface BuildSessionContextOptions {
	/** Build the display transcript instead of the LLM context. By default this preserves every path entry with compactions inline; set */
	transcript?: boolean;
	/** In transcript mode, elide entries replaced by the latest compaction. */
	collapseCompactedHistory?: boolean;
	/** Transcript mode only: keep `toolCall` blocks that have no matching `toolResult` on the path instead of stripping them. Pass this when the */
	keepDanglingToolCalls?: boolean;
}

/** Display-only marker set on transcript assistant messages whose dangling `toolCall` blocks were stripped (no paired result on the resolved path — */
export interface StrippedToolCallsMarker {
	strippedToolCalls?: number;
}

/** Build the session context from entries using tree traversal. If leafId is provided, walks from that entry to root. */
/** Re-attach the plaintext source of a legacy image-archive compaction as a single text block, so an old session whose compaction persisted a frame */
function legacyArchiveBlocksForContext(
	preserveData: Record<string, unknown> | undefined,
	options: BuildSessionContextOptions | undefined,
): TextContent[] | undefined {
	if (options?.transcript && options.collapseCompactedHistory) return undefined;
	const text = legacyArchiveSourceText(preserveData);
	if (!text) return undefined;
	return [{ type: "text", text: `Recovered archived history from a prior compaction:\n\n${text}` }];
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options?: BuildSessionContextOptions,
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
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
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
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

	// Walk from leaf to root, collecting path
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	// Extract settings and find compaction
	let thinkingLevel: string | undefined = "off";
	let configuredThinkingLevel: string | undefined;
	let serviceTier: ServiceTierByFamily | undefined;
	const models: Record<string, string> = {};
	let compaction: CompactionEntry | null = null;
	const injectedTtsrRulesSet = new Set<string>();
	let selectedMCPToolNames: string[] = [];
	let hasPersistedMCPToolSelection = false;
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;
	// Track whether an explicit `model_change` with role="default" has been seen on this path. Once a user (or the agent itself) records an
	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
			// New format: { model: "provider/id", role?: string }
			if (entry.model) {
				const role = entry.role ?? "default";
				models[role] = entry.model;
				if (role === "default") {
					hasExplicitDefaultModel = true;
				}
			}
		} else if (entry.type === "service_tier_change") {
			serviceTier = coerceServiceTierByFamily(entry.serviceTier);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// Legacy fallback: infer default model from assistant messages only when no explicit `model_change` (role=default) entry has been
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction" && !hasLegacyProviderNativeCompaction(entry.preserveData)) {
			// A compaction written by the removed provider-native remote path is NOT an effective compaction for this rebuild. Its `summary` is the
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
			// Collect injected TTSR rule names
			for (const ruleName of entry.injectedRules) {
				injectedTtsrRulesSet.add(ruleName);
			}
		} else if (entry.type === "mcp_tool_selection") {
			selectedMCPToolNames = entry.selectedToolNames.slice();
			hasPersistedMCPToolSelection = true;
		} else if (entry.type === "mode_change") {
			mode = entry.mode;
			modeData = entry.data;
		}
	}

	const injectedTtsrRules = Array.from(injectedTtsrRulesSet);

	// Build messages and collect corresponding entries When there's a compaction, we need to:
	const messages: AgentMessage[] = [];
	const cacheMissExplainedAt: boolean[] = [];
	let pendingReset = false;
	let currentMode = "none";
	let lastAssistantModel: string | undefined;

	const handleEntryResetTracking = (entry: SessionEntry) => {
		if (entry.type === "compaction") {
			pendingReset = true;
		} else if (entry.type === "model_change") {
			pendingReset = true;
		} else if (entry.type === "mode_change") {
			const isPlanTransition = (entry.mode === "plan") !== (currentMode === "plan");
			if (isPlanTransition) {
				pendingReset = true;
			}
			currentMode = entry.mode;
		}
	};

	const pushMessage = (msg: AgentMessage) => {
		messages.push(msg);
		if (!options?.transcript) return;
		if (msg.role === "assistant") {
			const currentModel = `${msg.provider}/${msg.model}`;
			const modelChanged = lastAssistantModel !== undefined && lastAssistantModel !== currentModel;
			lastAssistantModel = currentModel;
			cacheMissExplainedAt.push(pendingReset || modelChanged);
			pendingReset = false;
		} else {
			cacheMissExplainedAt.push(false);
		}
	};

	// A recovered assistant turn is dropped from the model's context below, and the tool results paired to it have to go with it. A retried transport death pairs every call
	let orphanedCallIds: Set<string> | undefined;

	const appendMessage = (entry: SessionEntry) => {
		handleEntryResetTracking(entry);
		if (entry.type === "message") {
			const message = entry.message;
			if (!options?.transcript && message.role === "assistant" && message.retryRecovery?.status === "recovered") {
				orphanedCallIds = new Set<string>();
				for (const block of message.content) {
					if (block.type === "toolCall") orphanedCallIds.add(block.id);
				}
				return;
			}
			if (orphanedCallIds !== undefined) {
				if (message.role === "toolResult" && orphanedCallIds.delete(message.toolCallId)) return;
				orphanedCallIds = undefined;
			}
			pushMessage(message);
		} else if (entry.type === "custom_message") {
			if (!isCustomMessageContent(entry.content)) return;
			const normalized = normalizeCustomMessagePayload(entry);
			const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
			pushMessage(
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
			pushMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (options?.transcript && !options.collapseCompactedHistory) {
		// Display transcript: every entry in chronological order. Compactions do not erase prior history here — each renders inline (as a divider in the
		for (const entry of path) {
			handleEntryResetTracking(entry);
			if (entry.type === "compaction") {
				pushMessage(
					createCompactionSummaryMessage(
						entry.summary,
						entry.tokensBefore,
						entry.timestamp,
						entry.shortSummary,
						remoteCompactionProviderPayload(entry.preserveData),
						undefined,
						legacyArchiveBlocksForContext(entry.preserveData, options),
						entry.warning,
						remoteCompactionAttribution(entry.preserveData),
					),
				);
			} else {
				appendMessage(entry);
			}
		}
	} else if (compaction) {
		// A remote compaction entry carries the provider's window and NO readable summary: the window is the compacted context, and billing a second model
		const remotePayload = remoteCompactionProviderPayload(compaction.preserveData);
		const remoteData = getRemoteCompactionPreserveData(compaction.preserveData);
		const activeProvider = models.default?.split("/")[0];
		const replayable =
			remotePayload !== undefined &&
			remoteData !== undefined &&
			(activeProvider === undefined || activeProvider === remoteData.provider);
		const usableCompaction = replayable || compaction.summary.trim().length > 0;

		// Re-attach any legacy archived history as text so the model can keep
		// reading it after every context rebuild (old sessions only).
		const compactionSummaryMsg = createCompactionSummaryMessage(
			compaction.summary,
			compaction.tokensBefore,
			compaction.timestamp,
			compaction.shortSummary,
			remotePayload,
			undefined,
			legacyArchiveBlocksForContext(compaction.preserveData, options),
			compaction.warning,
			remoteCompactionAttribution(compaction.preserveData),
		);
		// Agent context (non-transcript): summary first so the LLM sees the
		// compacted context before recent messages.
		if (!options?.transcript && usableCompaction) {
			pushMessage(compactionSummaryMsg);
		}

		// Find compaction index in path
		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

		// Emit the kept pre-compaction entries, starting at the compaction's keep marker. The marker names the first pre-compaction entry the compaction kept verbatim, and
		const keptFrom = usableCompaction ? resolveCompactionBoundaryIndex(path, compaction.firstKeptEntryId) : 0;
		if (
			usableCompaction &&
			compaction.firstKeptEntryId !== KEEP_NOTHING_ENTRY_ID &&
			keptFrom === 0 &&
			path[0]?.id !== compaction.firstKeptEntryId
		) {
			logger.warn("Compaction keep marker names no entry on the branch; re-expanding the pre-compaction span", {
				compactionId: compaction.id,
				firstKeptEntryId: compaction.firstKeptEntryId,
			});
		}
		for (let i = keptFrom; i < compactionIdx; i++) {
			appendMessage(path[i]);
		}

		// Display transcript: emit the summary at the chronological compaction point (after kept messages, before post-compaction) so it stays in
		if (options?.transcript) handleEntryResetTracking(compaction);
		if (options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		// Emit messages after compaction
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// No compaction - emit all messages, handle branch summaries and custom messages
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	// Strip dangling tool_use blocks — a tool_use with no matching tool_result on the resolved leaf→root path — from ANY assistant turn, not just the trailing one.
	const keepDangling = options?.transcript === true && options.keepDanglingToolCalls === true;
	if (!keepDangling) {
		const pairedToolResultIds = new Set<string>();
		for (const message of messages) {
			if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			let strippedToolCalls = 0;
			for (const block of message.content) {
				if (block.type === "toolCall" && !pairedToolResultIds.has(block.id)) strippedToolCalls++;
			}
			if (strippedToolCalls === 0) continue;
			const normalized = message.content
				.filter(
					block =>
						!(block.type === "toolCall" && !pairedToolResultIds.has(block.id)) &&
						block.type !== "redactedThinking",
				)
				.map(block =>
					block.type === "thinking" && block.thinkingSignature
						? { ...block, thinkingSignature: undefined }
						: block,
				);
			if (normalized.length === 0 && !options?.transcript) {
				messages.splice(i, 1);
			} else {
				const rewritten = { ...message, content: normalized };
				if (options?.transcript) {
					// Display transcript: keep the turn (even content-less) and mark
					// how many calls were dropped so the TUI renders a placeholder
					// row instead of silently erasing the turn's activity.
					(rewritten as AgentMessage & StrippedToolCallsMarker).strippedToolCalls = strippedToolCalls;
				}
				messages[i] = rewritten;
			}
		}
	}

	return {
		messages,
		cacheMissExplainedAt: options?.transcript ? cacheMissExplainedAt : undefined,
		thinkingLevel,
		configuredThinkingLevel,
		serviceTier,
		models,
		injectedTtsrRules,
		selectedMCPToolNames,
		hasPersistedMCPToolSelection,
		mode,
		modeData,
	};
}

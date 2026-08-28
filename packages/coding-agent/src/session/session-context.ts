import type { AgentMessage } from "@veyyon/agent-core";
import { KEEP_NOTHING_ENTRY_ID, resolveCompactionBoundaryIndex } from "@veyyon/agent-core/compaction/entries";
import { hasLegacyProviderNativeCompaction } from "@veyyon/agent-core/compaction/legacy-provider-native";
import { legacyArchiveSourceText } from "@veyyon/agent-core/compaction/legacy-snapcompact-archive";
import {
	getRemoteCompactionPreserveData,
	remoteCompactionAttribution,
	remoteCompactionProviderPayload,
} from "@veyyon/agent-core/compaction/remote-compaction-entry";
import type { TextContent } from "@veyyon/ai";
import { coerceServiceTierByFamily, type ServiceTierByFamily } from "@veyyon/ai/types";
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
	configuredThinkingLevel?: string;
	serviceTier?: ServiceTierByFamily;
	models: Record<string, string>;
	injectedTtsrRules: string[];
	selectedMCPToolNames: string[];
	hasPersistedMCPToolSelection: boolean;
	mode: string;
	modeData?: Record<string, unknown>;
	cacheMissExplainedAt?: boolean[];
}

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
	transcript?: boolean;
	collapseCompactedHistory?: boolean;
	keepDanglingToolCalls?: boolean;
}

export interface StrippedToolCallsMarker {
	strippedToolCalls?: number;
}

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
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
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

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

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
	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
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
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction" && !hasLegacyProviderNativeCompaction(entry.preserveData)) {
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
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
		const remotePayload = remoteCompactionProviderPayload(compaction.preserveData);
		const remoteData = getRemoteCompactionPreserveData(compaction.preserveData);
		const activeProvider = models.default?.split("/")[0];
		const replayable =
			remotePayload !== undefined &&
			remoteData !== undefined &&
			(activeProvider === undefined || activeProvider === remoteData.provider);
		const usableCompaction = replayable || compaction.summary.trim().length > 0;

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
		if (!options?.transcript && usableCompaction) {
			pushMessage(compactionSummaryMsg);
		}

		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

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

		if (options?.transcript) handleEntryResetTracking(compaction);
		if (options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

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

/**
 * The inputs a session's system prompt is rebuilt from: the project it renders (re-discovered when
 * the session's cwd moves), the appended-prompt blocks, the discoverable-tool listing, and the
 * caller's replacement prompt.
 */

import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import type { DiscoveredAdvisors } from "../advisor/config";
import type { Rule } from "../discovery/capability/rule";
import { type BucketRulesOptions, bucketRules, type RuleBuckets } from "../discovery/capability/rule-buckets";
import type { EffectiveToolDiscoveryMode } from "../discovery/mode";
import {
	collectDiscoverableTools,
	type DiscoverableTool,
	filterBySource,
	formatDiscoverableToolServerSummary,
	summarizeDiscoverableTools,
} from "../discovery/tool-index";
import type { TtsrManager } from "../export/ttsr";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { BuildSystemPromptResult } from "../system-prompt";
import type { ContextFileEntry } from "../tools";
import { TOOL } from "../tools/core/builtin-names";
import type { ActiveRepoContext } from "../utils/active-repo-context";
import type { WorkspaceTree } from "../workspace-tree";
import type { ProjectInputDiscovery } from "./factory-extensions";
import { MAX_MCP_INSTRUCTIONS_LENGTH } from "./factory-mcp";
import type { CreateAgentSessionOptions } from "./factory-options";

/** The project inputs the system prompt renders. */
export interface ProjectPromptSnapshot {
	readonly cwd: string;
	readonly contextFiles: ContextFileEntry[];
	/** A pending scan at startup: the prompt races it again on every build until it settles. */
	readonly workspaceTree: WorkspaceTree | Promise<WorkspaceTree>;
	readonly activeRepoContext: ActiveRepoContext | null;
	readonly skills: Skill[];
	readonly rulebookRules: Rule[];
	readonly alwaysApplyRules: Rule[];
}

/** Every input discovered for the directory a session moved to, TTSR rules already registered. */
export interface DiscoveredProjectInputs {
	readonly cwd: string;
	readonly contextFiles: ContextFileEntry[];
	readonly workspaceTree: WorkspaceTree;
	readonly activeRepoContext: ActiveRepoContext | null;
	readonly skills: Skill[];
	readonly skillWarnings: SkillWarning[];
	/** Every discovered rule, before bucketing. */
	readonly rules: Rule[];
	readonly buckets: RuleBuckets;
	readonly watchdogFiles: string[];
	readonly advisors: DiscoveredAdvisors;
}

export interface ProjectPromptInputsOptions {
	readonly initial: ProjectPromptSnapshot;
	/** The session's live cwd; `set_cwd` and `/move` change it mid-session. */
	getCwd(): string;
	discover(cwd: string): ProjectInputDiscovery;
	readonly ttsrManager: TtsrManager;
	ttsrOptions(): BucketRulesOptions;
	/** Installs a moved project's inputs everywhere outside the prompt. Runs after {@link ProjectPromptInputs.current} changes. */
	onChange(next: DiscoveredProjectInputs): void;
}

/**
 * The project a session's system prompt renders, re-discovered when the session's cwd moves.
 *
 * Refreshes run one at a time. A refresh whose cwd moved again while it discovered is discarded
 * rather than installing one project's inputs under another project's path, and the caller then
 * refreshes for the newer cwd. A failed TTSR registration restores the previous rule set and leaves
 * the snapshot unchanged.
 */
export class ProjectPromptInputs {
	#snapshot: ProjectPromptSnapshot;
	#pending: Promise<void> = Promise.resolve();
	readonly #options: ProjectPromptInputsOptions;

	constructor(options: ProjectPromptInputsOptions) {
		this.#options = options;
		this.#snapshot = options.initial;
	}

	get current(): ProjectPromptSnapshot {
		return this.#snapshot;
	}

	/** Re-discover the project when the live cwd differs from the rendered one; resolves once they agree. */
	async refresh(): Promise<void> {
		if (this.#liveCwd() === this.#snapshot.cwd) return;
		const refresh = this.#pending.catch(() => undefined).then(() => this.#discoverLiveCwd());
		this.#pending = refresh;
		await refresh;
		if (this.#liveCwd() !== this.#snapshot.cwd) await this.refresh();
	}

	#liveCwd(): string {
		return path.resolve(this.#options.getCwd());
	}

	async #discoverLiveCwd(): Promise<void> {
		const cwd = this.#liveCwd();
		if (cwd === this.#snapshot.cwd) return;

		const discovery = this.#options.discover(cwd);
		const [contextFiles, workspaceTree, activeRepoContext, skillsResult, rules, watchdogFiles, advisors] =
			await Promise.all([
				discovery.contextFiles,
				discovery.workspaceTree,
				discovery.activeRepoContext,
				discovery.skills,
				discovery.rules,
				discovery.watchdogFiles,
				discovery.advisors,
			]);
		if (this.#liveCwd() !== cwd) return;

		const buckets = this.#registerRules(rules);
		const next: DiscoveredProjectInputs = {
			cwd,
			contextFiles,
			workspaceTree,
			activeRepoContext,
			skills: skillsResult.skills,
			skillWarnings: skillsResult.warnings,
			rules,
			buckets,
			watchdogFiles,
			advisors,
		};
		this.#snapshot = {
			cwd,
			contextFiles,
			workspaceTree,
			activeRepoContext,
			skills: next.skills,
			rulebookRules: buckets.rulebookRules,
			alwaysApplyRules: buckets.alwaysApplyRules,
		};
		this.#options.onChange(next);
	}

	/** Replace the TTSR rule set with `rules`, restoring the previous set when registration throws. */
	#registerRules(rules: readonly Rule[]): RuleBuckets {
		const { ttsrManager } = this.#options;
		const previous = ttsrManager.getRules();
		ttsrManager.clearRules();
		try {
			return bucketRules(rules, ttsrManager, this.#options.ttsrOptions());
		} catch (error) {
			ttsrManager.clearRules();
			for (const rule of previous) ttsrManager.addRule(rule);
			throw error;
		}
	}
}

/**
 * The appended-prompt text: memory instructions, auto-learn guidance, the connected MCP servers'
 * instructions (each clipped to {@link MAX_MCP_INSTRUCTIONS_LENGTH}), then the caller's append.
 * Undefined when every part is empty.
 */
export function composeAppendPrompt(parts: {
	memoryInstructions: string | undefined;
	autoLearnInstructions: string | null;
	serverInstructions: ReadonlyMap<string, string> | undefined;
	appendSystemPrompt: string | undefined;
}): string | undefined {
	const blocks: string[] = [];
	if (parts.memoryInstructions) blocks.push(parts.memoryInstructions);
	if (parts.autoLearnInstructions) blocks.push(parts.autoLearnInstructions);
	if (parts.serverInstructions && parts.serverInstructions.size > 0) {
		blocks.push(
			"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
		);
		for (const [server, instructions] of parts.serverInstructions) {
			const clipped =
				instructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
					? `${instructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
					: instructions;
			blocks.push(`### ${server}\n${clipped}`);
		}
	}
	if (parts.appendSystemPrompt) blocks.push(parts.appendSystemPrompt);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/** The tools the prompt lists as loadable through `search_tool_bm25`. */
export interface PromptDiscoverableTools {
	/** Inactive discoverable local tools (mode `all` only), then every MCP tool when MCP discovery is on. */
	readonly tools: DiscoverableTool[];
	/** True when the prompt teaches discovery: MCP discovery is on, the search tool is active, and it has tools to find. */
	readonly searchable: boolean;
	readonly serverSummaries: string[];
}

export function promptDiscoverableTools(input: {
	tools: ReadonlyMap<string, AgentTool>;
	activeToolNames: readonly string[];
	mcpDiscoveryEnabled: boolean;
	discoveryMode: EffectiveToolDiscoveryMode;
	builtInToolNames: ReadonlySet<string>;
}): PromptDiscoverableTools {
	const active = new Set(input.activeToolNames);
	const local =
		input.discoveryMode === "all"
			? Array.from(input.tools.values()).flatMap(tool => {
					if (tool.loadMode !== "discoverable" || active.has(tool.name)) return [];
					return collectDiscoverableTools([tool], {
						source: input.builtInToolNames.has(tool.name) ? "builtin" : "custom",
					});
				})
			: [];
	const mcp = input.mcpDiscoveryEnabled ? filterBySource(collectDiscoverableTools(input.tools.values()), "mcp") : [];
	const tools = local.concat(mcp);
	return {
		tools,
		searchable: input.mcpDiscoveryEnabled && active.has(TOOL.search_tool_bm25) && tools.length > 0,
		serverSummaries: summarizeDiscoverableTools(tools).servers.map(formatDiscoverableToolServerSummary),
	};
}

/** The prompt a session sends: the assembled one, or the caller's replacement for it. */
export function applySystemPromptOverride(
	assembled: BuildSystemPromptResult,
	override: CreateAgentSessionOptions["systemPrompt"],
): BuildSystemPromptResult {
	if (override === undefined) return assembled;
	const replacement = typeof override === "function" ? override(assembled.systemPrompt) : override;
	return {
		systemPrompt: typeof replacement === "string" ? [replacement] : replacement,
		// The caller replaced the assembled prompt, so no statement produced these blocks.
		statementContext: null,
		statementOverrides: null,
		replacedStatementSections: [],
	};
}

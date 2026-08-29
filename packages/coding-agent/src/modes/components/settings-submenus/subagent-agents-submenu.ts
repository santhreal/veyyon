import type { Model } from "@veyyon/ai";
import { matchesKey, type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp, errorMessage } from "@veyyon/utils";
import type { ModelRegistry } from "../../../config/model-registry";
import { extractExplicitThinkingSelector, normalizeModelPatternList } from "../../../config/model-resolver";
import { settings } from "../../../config/settings";
import type { SubagentAgentSettings, SubagentLaneSettings } from "../../../config/settings-domains/subagents";
import { discoverAgents } from "../../../task/discovery";
import {
	delegationBlockedNotice,
	isSubagentEnableDefaulted,
	nextSubagentEnableValue,
	resolveDelegation,
	resolveSubagentMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	SUBAGENT_ENABLE_STATE_LABEL,
	subagentEnableState,
	subagentModelSourceLabel,
	subagentSettingsFor,
} from "../../../task/subagent-settings";
import type { AgentDefinition } from "../../../task/types";
import { INHERIT_EFFORT_OPTION_VALUE } from "../../../thinking";
import { getSelectListTheme, theme } from "../../theme/theme";
import { formatSelectorSummary } from "../effort-picker";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { SelectSubmenu } from "../settings-submenus";
import { ModelChainSubmenu } from "./model-chain-submenu";
import type { SubagentEffortScope, SubagentRosterPath } from "./subagent-agents-submenu-helpers";

export * from "./subagent-agents-submenu-helpers";

import {
	AGENT_ROW_EFFORT,
	AGENT_ROW_MODEL,
	AGENT_ROW_NESTED,
	AGENT_ROW_OFFERED,
	AGENT_ROW_RESET,
	effortScopeForPattern,
	lanePath,
	laneSpawnEnabled,
	pruneLane,
	subagentEffortOptions,
	subagentEffortScope,
} from "./subagent-agents-submenu-helpers";

export class SubagentAgentsSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#agents: AgentDefinition[] = [];
	#loadError: string | undefined;
	#loaded = false;
	#escapeTo: (() => void) | undefined;

	constructor(
		private readonly cwd: string,
		private readonly activeModelPattern: string | undefined,
		private readonly sessionModel: Model | undefined,
		private readonly models: ReadonlyArray<Model> | undefined,
		private readonly picker: { registry: ModelRegistry; models: ReadonlyArray<Model> } | undefined,
		private readonly onChange: (path: SubagentRosterPath) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showAgentList();
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const { agents } = await discoverAgents(this.cwd);
			this.#agents = agents.slice().sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			this.#loadError = errorMessage(error);
		}
		this.#loaded = true;
		this.#showAgentList();
		this.requestRender?.();
	}

	#table(): Record<string, SubagentAgentSettings> {
		const stored = settings.get("subagent.agents");
		return stored && typeof stored === "object" ? ({ ...stored } as Record<string, SubagentAgentSettings>) : {};
	}

	#row(name: string): SubagentAgentSettings {
		return { ...subagentSettingsFor(settings, name) };
	}

	#lane(name: string, depth: number): SubagentLaneSettings {
		let lane: SubagentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) lane = lane.subagents ?? {};
		return { ...lane };
	}

	#writeLane(name: string, depth: number, next: SubagentLaneSettings): void {
		const chain: SubagentLaneSettings[] = [];
		let lane: SubagentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) {
			chain.push(lane);
			lane = lane.subagents ?? {};
		}
		let rebuilt = pruneLane(next);
		for (let step = chain.length - 1; step >= 0; step--) {
			rebuilt = pruneLane({ ...chain[step], subagents: rebuilt });
		}

		const table = this.#table();
		if (rebuilt === undefined) delete table[name];
		else table[name] = rebuilt;
		settings.set("subagent.agents", table);
		this.onChange("subagent.agents");
	}

	#modelSummary(agent: AgentDefinition, depth = 0): string {
		const resolved = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			activeModelPattern: this.activeModelPattern,
			taskDepth: depth + 1,
		});
		if (resolved.unresolved) return theme.fg("error", `${resolved.unresolved.value} matches no model`);
		const pattern = resolved.patterns[0];
		if (!pattern) return theme.fg("dim", "no model resolved");
		const fallbacks = resolved.patterns.length - 1;
		const summary =
			fallbacks > 0
				? `${formatSelectorSummary(pattern)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
				: formatSelectorSummary(pattern);
		return resolved.source === "inherit"
			? theme.fg("dim", `inherit · ${summary}`)
			: `${summary} ${theme.fg("dim", `· ${subagentModelSourceLabel(resolved.source, agent.name, resolved.depth)}`)}`;
	}

	#laneModelSummary(lane: SubagentLaneSettings, depth: number): string {
		const chain = lane.model;
		if (chain === undefined || (Array.isArray(chain) ? chain.length === 0 : chain.trim().length === 0)) {
			return theme.fg("dim", depth === 0 ? "inherit · the session's model" : "inherit · the level above");
		}
		const entries = Array.isArray(chain) ? chain : [chain];
		const head = entries[0] ?? "";
		const fallbacks = entries.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(head)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
			: formatSelectorSummary(head);
	}

	#laneEffortSummary(lane: SubagentLaneSettings, depth: number): string {
		const level = lane.thinkingLevel?.trim() ?? "";
		return level.length > 0
			? level
			: theme.fg("dim", depth === 0 ? "inherit · the session's effort" : "inherit · the level above");
	}

	#runsSummary(agent: AgentDefinition, depth = 0): string {
		const model = this.#modelSummary(agent, depth);
		const head = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			activeModelPattern: this.activeModelPattern,
			taskDepth: depth + 1,
		}).patterns[0];
		if (head && extractExplicitThinkingSelector(head, settings) !== undefined) return model;
		const effort = resolveSubagentThinkingLevel({
			settings,
			agentName: agent.name,
			agentThinkingLevel: agent.thinkingLevel,
			taskDepth: depth + 1,
		});
		return `${model} ${theme.fg("dim", `· ${effort ?? "inherited"} effort`)}`;
	}

	#showAgentList(): void {
		this.clear();
		this.#escapeTo = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Subagents")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Which subagent types this session offers, and what they all run. The first two rows are the model and the effort every subagent uses; the rest are the lanes.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.#selectList = undefined;

		if (this.#loadError) {
			this.addChild(new Text(theme.fg("error", `  Could not read the agent directories: ${this.#loadError}`), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		if (!this.#loaded) {
			this.addChild(new Text(theme.fg("dim", "  Reading subagents…"), 0, 0));
			return;
		}

		const blocked = delegationBlockedNotice(
			resolveDelegation(
				settings,
				this.#agents
					.filter(agent => subagentEnableState(agent, this.#row(agent.name).enabled) === "on")
					.map(agent => agent.name),
			),
		);
		if (blocked) {
			this.addChild(new Text(theme.fg("warning", `  ${blocked}`), 0, 0));
			this.addChild(new Spacer(1));
		}

		const items: SelectItem[] = [
			{
				value: AGENT_ROW_MODEL,
				label: "Model",
				description: `every subagent · ${this.#blanketModelSummary()}`,
			},
			{
				value: AGENT_ROW_EFFORT,
				label: "Effort",
				description: `every subagent · ${this.#blanketEffortSummary()}`,
			},
			...this.#agents.map(agent => ({
				value: agent.name,
				label: agent.name,
				description: `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, this.#row(agent.name).enabled)]} · ${this.#modelSummary(agent)}`,
			})),
		];
		if (this.#agents.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No subagent types found."), 0, 0));
			this.addChild(new Spacer(1));
		}

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === AGENT_ROW_MODEL) this.#showModelPicker(() => this.#showAgentList());
			else if (item.value === AGENT_ROW_EFFORT) this.#showEffortPicker(() => this.#showAgentList());
			else this.#showAgentEditor(item.value);
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);

		const detail = new Text(this.#detailText(items[0]?.value), 0, 0);
		this.#selectList.onSelectionChange = item => {
			if (detail.setText(this.#detailText(item.value))) this.requestRender?.();
		};
		this.addChild(new Spacer(1));
		this.addChild(detail);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("dim", "  Enter to configure · /agents to write agent files · Esc to go back"), 0, 0),
		);
	}

	#agent(name: string): AgentDefinition | undefined {
		return this.#agents.find(candidate => candidate.name === name);
	}

	#detailText(name: string | undefined): string {
		if (name === AGENT_ROW_MODEL) {
			return theme.fg(
				"muted",
				"  The model chain every subagent runs. Unset means they follow this session's model.",
			);
		}
		if (name === AGENT_ROW_EFFORT) {
			return theme.fg(
				"muted",
				"  The thinking effort every subagent runs at. Inherit follows this session's effort.",
			);
		}
		const description = name ? this.#agent(name)?.description?.trim() : undefined;
		return description ? theme.fg("muted", `  ${description}`) : "";
	}

	#blanketModelSummary(): string {
		const chain = normalizeModelPatternList(settings.get("subagent.model"));
		const head = chain[0];
		if (!head) return theme.fg("dim", `inherit · ${this.activeModelPattern ?? "session model"}`);
		const fallbacks = chain.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(head)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
			: formatSelectorSummary(head);
	}

	#blanketEffortSummary(): string {
		const stored = settings.get("subagent.thinkingLevel");
		const level = typeof stored === "string" ? stored.trim() : "";
		return level.length > 0 ? level : theme.fg("dim", "inherit");
	}

	#showAgentEditor(name: string, depth = 0): void {
		const agent = this.#agent(name);
		if (!agent) {
			this.#showAgentList();
			return;
		}
		const lane = this.#lane(name, depth);
		const child = lane.subagents ?? {};
		const resolvedMax = resolveSubagentMaxNestedSpawnDepth(settings, name);
		const spawnAllowed = laneSpawnEnabled(child, depth + 1, resolvedMax);

		this.clear();
		this.#escapeTo = undefined;
		const trail = depth === 0 ? `Subagent: ${name}` : `${name}${" › subagents".repeat(depth)}`;
		this.addChild(new Text(theme.bold(theme.fg("accent", trail)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					depth === 0
						? agent.description || `${agent.source} subagent`
						: `What ${depth === 1 ? name : "this lane"} may spawn. Unset follows the level above.`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(`  ${theme.fg("muted", "Runs")} ${this.#runsSummary(agent, depth)}`, 0, 0));
		this.addChild(new Spacer(1));
		const items: SelectItem[] = [
			{
				value: AGENT_ROW_OFFERED,
				label: "Enabled",
				description:
					depth === 0
						? `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, lane.enabled)]}${
								isSubagentEnableDefaulted(lane.enabled) ? theme.fg("dim", " (default)") : ""
							}`
						: `${laneSpawnEnabled(lane, depth, resolvedMax) ? "on" : "off"}${
								lane.enabled === undefined ? theme.fg("dim", " (default)") : ""
							}`,
			},
			{
				value: AGENT_ROW_MODEL,
				label: "Model",
				description: this.#laneModelSummary(lane, depth),
			},
			{
				value: AGENT_ROW_EFFORT,
				label: "Effort",
				description: this.#laneEffortSummary(lane, depth),
			},
			{
				value: AGENT_ROW_NESTED,
				label: "Subagents",
				description: spawnAllowed
					? this.#laneModelSummary(child, depth + 1)
					: theme.fg("dim", "off · this lane may not spawn"),
			},
		];
		if (Object.keys(lane).length > 0) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", `clears ${lanePath(name, depth)}`),
			});
		}

		this.#selectList = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		this.#selectList.onSelect = item => {
			switch (item.value) {
				case AGENT_ROW_OFFERED:
					this.#writeLane(
						name,
						depth,
						depth === 0
							? { ...lane, enabled: nextSubagentEnableValue(agent, lane.enabled) }
							: { ...lane, enabled: !laneSpawnEnabled(lane, depth, resolvedMax) },
					);
					this.#showAgentEditor(name, depth);
					break;
				case AGENT_ROW_MODEL:
					this.#showLaneModelPicker(name, depth);
					break;
				case AGENT_ROW_EFFORT:
					this.#showLaneEffortPicker(name, depth);
					break;
				case AGENT_ROW_NESTED:
					this.#showAgentEditor(name, depth + 1);
					break;
				case AGENT_ROW_RESET:
					this.#writeLane(name, depth, {});
					this.#showAgentEditor(name, depth);
					break;
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => {
			if (depth === 0) this.#showAgentList();
			else this.#showAgentEditor(name, depth - 1);
			this.requestRender?.();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to change · Esc to go back"), 0, 0));
	}

	#showLaneModelPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		if (!this.picker) {
			this.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		const lane = this.#lane(name, depth);
		this.addChild(
			new ModelChainSubmenu(
				{
					write: chain => {
						const next = { ...this.#lane(name, depth) };
						if (chain === undefined) delete next.model;
						else next.model = chain;
						this.#writeLane(name, depth, next);
					},
				},
				this.picker.registry,
				this.picker.models,
				depth === 0 ? `Model · ${name}` : `Model · what ${name} spawns${" (nested)".repeat(depth - 1)}`,
				lane.model,
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => this.onChange("subagent.agents"),
				this.requestRender,
			),
		);
	}

	#showLaneEffortPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		const lane = this.#lane(name, depth);
		const { options, notice } = subagentEffortOptions(this.#laneEffortScope(name, depth), this.models);
		const description =
			notice === undefined
				? depth === 0
					? `Effort ${name} runs at. Inherit follows the session's effort; a \`:level\` on the model chain still wins.`
					: "Effort this lane runs at. Inherit follows the level above."
				: `Effort this lane runs at. ${notice}`;
		this.addChild(
			new SelectSubmenu(
				depth === 0 ? `Effort · ${name}` : `Effort · what ${name} spawns`,
				description,
				options,
				lane.thinkingLevel?.trim() ?? "",
				value => {
					const next = { ...this.#lane(name, depth) };
					if (value === INHERIT_EFFORT_OPTION_VALUE) delete next.thinkingLevel;
					else next.thinkingLevel = value;
					this.#writeLane(name, depth, next);
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
			),
		);
	}

	#laneEffortScope(name: string, depth: number): SubagentEffortScope {
		const head = resolveSubagentModel({
			settings,
			agentName: name,
			activeModelPattern: this.activeModelPattern,
			taskDepth: depth + 1,
		}).patterns[0];
		return effortScopeForPattern(this.models, head, this.sessionModel);
	}

	#showModelPicker(back: () => void): void {
		this.clear();
		this.#selectList = undefined;
		this.#escapeTo = back;
		if (!this.picker) {
			this.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		const stored: unknown = settings.get("subagent.model");
		let current: string | string[] | undefined;
		if (typeof stored === "string") current = stored;
		else if (Array.isArray(stored) && stored.every(entry => typeof entry === "string")) current = stored;
		this.addChild(
			new ModelChainSubmenu(
				"subagent.model",
				this.picker.registry,
				this.picker.models,
				"Subagent Model · every subagent",
				current,
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => this.onChange("subagent.model"),
				this.requestRender,
			),
		);
	}

	#showEffortPicker(back: () => void): void {
		this.clear();
		this.#selectList = undefined;
		this.#escapeTo = back;
		const { options, notice } = subagentEffortOptions(
			subagentEffortScope(this.models, this.sessionModel),
			this.models,
		);
		const stored = settings.get("subagent.thinkingLevel");
		const current = typeof stored === "string" ? stored.trim() : "";
		const description =
			notice === undefined
				? "Effort for every subagent. Inherit follows the session's effort; a `:level` on the model chain still wins."
				: `Effort for every subagent. ${notice}`;
		this.addChild(
			new SelectSubmenu(
				"Subagent Effort · every subagent",
				description,
				options,
				current,
				value => {
					if (value === INHERIT_EFFORT_OPTION_VALUE) settings.unset("subagent.thinkingLevel");
					else settings.set("subagent.thinkingLevel", value);
					this.onChange("subagent.thinkingLevel");
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
			),
		);
	}

	mouseTarget(): SelectList | ModelChainSubmenu | SelectSubmenu | undefined {
		if (this.#selectList) return this.#selectList;
		return this.children.find(
			(child): child is ModelChainSubmenu | SelectSubmenu =>
				child instanceof ModelChainSubmenu || child instanceof SelectSubmenu,
		);
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		if (this.#escapeTo && (matchesKey(data, "escape") || data === "\x1b")) {
			const back = this.#escapeTo;
			this.#escapeTo = undefined;
			back();
			this.requestRender?.();
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

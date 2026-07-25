/**
 * AgentDashboard - dedicated control center for Task subagent configuration.
 *
 * Layout:
 * - Top: source tabs (All, Project, User, Bundled)
 * - Body: two-column view (agent list + inspector)
 *
 * Controls:
 * - Up/Down or j/k: move selection
 * - Tab / Shift+Tab or Left/Right: switch source tab
 * - Space: enable/disable selected agent
 * - Enter: edit model override for selected agent
 * - N: start agent creation flow
 * - Esc: clear search (if any) or close dashboard
 * - Ctrl+R: reload discovered agents
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type Component,
	Container,
	Editor,
	fuzzyMatch,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { clampLow, errorMessage, isEnoent, prompt } from "@veyyon/utils";
import { YAML } from "bun";
import { getConfigDirs } from "../../config";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelString, resolveConfiguredModelPatterns, resolveModelOverride } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../../config/model-roles";
import { Settings } from "../../config/settings";
import type { SubagentAgentSettings } from "../../config/settings-domains/subagents";
import { PROMPTS } from "../../prompts/registry";
import { createAgentSession } from "../../sdk";
import { discoverAgents } from "../../task/discovery";
import {
	nextSubagentEnableValue,
	type ResolvedSubagentModel,
	resolveSubagentModel,
	SUBAGENT_ENABLE_STATE_LABEL,
	type SubagentEnableState,
	subagentEnableState,
	subagentModelSourceLabel,
	subagentSettingsFor,
} from "../../task/subagent-settings";
import type { AgentDefinition, AgentSource } from "../../task/types";
import { shortenPath } from "../../tools/render-utils";
import { getEditorTheme, theme } from "../theme/theme";
import {
	matchesAppFollowUp,
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import {
	applyModalReveal,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	renderModalShell,
	withCompact,
} from "./modal-shell";
import { clampSelection, handleTabSwitchKey, searchableChar } from "./selector-helpers";

type SourceTabId = "all" | AgentSource;
type AgentScope = "project" | "user";

interface SourceTab {
	id: SourceTabId;
	label: string;
	count: number;
}

interface DashboardAgent extends AgentDefinition {
	/**
	 * The agent's `subagent.agents.<name>.enabled` value VERBATIM, including
	 * `undefined` for "no row".
	 *
	 * Three states, not two: an absent row means the shipped default, and for a
	 * bundled specialist that default is "not offered to the model, but still runs
	 * when a command or you name it outright" — which is what keeps `/review`
	 * working with the specialists off. Collapsing that to a boolean is what made
	 * the old dashboard claim an agent was disabled while a second setting still
	 * held a model for it.
	 */
	enabled?: boolean;
	overrideModel?: string;
}

/** This agent's enable state from the row value it carries. */
function enableStateOf(agent: DashboardAgent): SubagentEnableState {
	return subagentEnableState(agent, agent.enabled);
}

/**
 * Row prefix and label for each enable state. The wording comes from
 * {@link SUBAGENT_ENABLE_STATE_LABEL} so the settings tab says the same thing;
 * only the colour is chosen here.
 */
function enableStateDisplay(state: SubagentEnableState): { symbol: string; label: string; dim: boolean } {
	const label = SUBAGENT_ENABLE_STATE_LABEL[state];
	switch (state) {
		case "on":
		case "default-on":
			return { symbol: theme.fg("success", theme.status.enabled), label: theme.fg("success", label), dim: false };
		case "default-off":
			return { symbol: theme.fg("warning", theme.status.disabled), label: theme.fg("warning", label), dim: true };
		case "off":
			return { symbol: theme.fg("dim", theme.status.disabled), label: theme.fg("dim", label), dim: true };
	}
}

interface ModelResolution {
	resolved: string;
	thinkingLevel?: string;
	explicitThinkingLevel: boolean;
}

interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
}

interface AgentDashboardModelContext {
	modelRegistry?: ModelRegistry;
	activeModelPattern?: string;
	defaultModelPattern?: string;
}

const SOURCE_ORDER: Record<AgentSource, number> = {
	project: 0,
	user: 1,
	bundled: 2,
};

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};

/** ModalShell footer chips for the list/inspector view. */
const AGENT_LIST_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "space toggle" },
	{ label: "enter override" },
	{ label: "n new agent" },
	{ label: "left/right source" },
	{ label: "ctrl+r reload" },
	{ label: "esc close", clickable: true, id: "close" },
];

/** ModalShell footer chips for create/edit sub-views, which carry their own inline hint line. */
const AGENT_SUBVIEW_SHORTCUTS: readonly ModalShortcut[] = [{ label: "esc cancel", clickable: true, id: "close" }];

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;
function joinPatterns(patterns: string[]): string {
	if (patterns.length === 0) return "(session model)";
	return patterns.join(", ");
}

function formatResolution(resolution: ModelResolution): string {
	const resolved = theme.fg("success", resolution.resolved);
	if (!resolution.explicitThinkingLevel || !resolution.thinkingLevel) return resolved;
	return `${resolved} ${theme.fg("dim", `(${resolution.thinkingLevel})`)}`;
}

function matchAgent(agent: DashboardAgent, query: string): boolean {
	const text = `${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]} ${agent.overrideModel ?? ""}`;
	return query
		.trim()
		.split(/\s+/)
		.every(token => fuzzyMatch(token, text).matches);
}

function extractAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = message.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.map(block => {
				if (!block || typeof block !== "object") return "";
				if (!("type" in block) || (block as { type?: unknown }).type !== "text") return "";
				const value = (block as { text?: unknown }).text;
				return typeof value === "string" ? value : "";
			})
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return null;
}

function extractJsonObject(raw: string): string {
	const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) {
		return fenceMatch[1].trim();
	}
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end >= start) {
		return raw.slice(start, end + 1).trim();
	}
	return raw.trim();
}

function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
	const parsed = JSON.parse(extractJsonObject(raw)) as Partial<GeneratedAgentSpec>;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Model output is not a JSON object");
	}
	if (
		typeof parsed.identifier !== "string" ||
		typeof parsed.whenToUse !== "string" ||
		typeof parsed.systemPrompt !== "string"
	) {
		throw new Error("Model output is missing required fields (identifier, whenToUse, systemPrompt)");
	}

	const identifier = parsed.identifier.trim();
	const whenToUse = parsed.whenToUse.trim();
	const systemPrompt = parsed.systemPrompt.trim();

	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Generated identifier is invalid (must be lowercase kebab-case, 2+ words)");
	}
	if (!whenToUse.toLowerCase().startsWith("use this agent when")) {
		throw new Error("Generated whenToUse must start with 'Use this agent when...'");
	}
	if (!systemPrompt) {
		throw new Error("Generated systemPrompt is empty");
	}

	return { identifier, whenToUse, systemPrompt };
}

class AgentListPane implements Component {
	constructor(
		private readonly agents: DashboardAgent[],
		private readonly selectedIndex: number,
		private readonly scrollOffset: number,
		private readonly searchQuery: string,
		private readonly maxVisible: number,
	) {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const searchPrefix = theme.fg("muted", "Search: ");
		const searchText = this.searchQuery || theme.fg("dim", "type to filter");
		lines.push(`${searchPrefix}${searchText}`);
		lines.push("");

		if (this.agents.length === 0) {
			lines.push(theme.fg("muted", "  No agents found."));
			return lines;
		}

		const overflow = this.agents.length > this.maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.agents.length);

		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			const agent = this.agents[i];
			const selected = i === this.selectedIndex;
			const display = enableStateDisplay(enableStateOf(agent));
			const source = theme.fg("dim", `[${SOURCE_LABEL[agent.source]}]`);
			const override = agent.overrideModel ? ` ${theme.fg("warning", "(override)")}` : "";
			let line = ` ${display.symbol} ${replaceTabs(agent.name)} ${source}${override}`;

			if (selected) {
				line = theme.bg("selectedBg", theme.bold(theme.fg("accent", line)));
			} else if (display.dim) {
				line = theme.fg("dim", line);
			}

			rows.push(truncateToWidth(line, rowWidth));
		}

		const sv = new ScrollView(rows, {
			height: rows.length,
			scrollbar: "auto",
			totalRows: this.agents.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(this.scrollOffset);
		lines.push(...sv.render(width));

		return lines;
	}

	invalidate(): void {}
}

class AgentInspectorPane implements Component {
	constructor(
		private readonly agent: DashboardAgent | null,
		private readonly defaultPatterns: string[],
		private readonly defaultResolution: ModelResolution | undefined,
		private readonly effectivePatterns: string[],
		private readonly effectiveResolution: ModelResolution | undefined,
		private readonly effectiveModel: ResolvedSubagentModel | undefined,
	) {}

	render(width: number): readonly string[] {
		if (!this.agent) {
			return [theme.fg("muted", "Select an agent"), theme.fg("dim", "to inspect settings")];
		}

		const lines: string[] = [];
		const display = enableStateDisplay(enableStateOf(this.agent));
		const state = `${display.symbol} ${display.label}`;

		lines.push(theme.bold(theme.fg("accent", replaceTabs(this.agent.name))));
		lines.push("");
		lines.push(`${theme.fg("muted", "Status:")} ${state}`);
		lines.push(`${theme.fg("muted", "Source:")} ${SOURCE_LABEL[this.agent.source]}`);
		lines.push("");

		lines.push(`${theme.fg("muted", "Default pattern:")} ${replaceTabs(joinPatterns(this.defaultPatterns))}`);
		lines.push(
			`${theme.fg("muted", "Default resolves:")} ${this.defaultResolution ? this.#formatResolution(this.defaultResolution) : theme.fg("dim", "(unresolved)")}`,
		);
		lines.push(
			`${theme.fg("muted", "Override:")} ${this.agent.overrideModel ? theme.fg("warning", replaceTabs(this.agent.overrideModel)) : theme.fg("dim", "(none)")}`,
		);
		lines.push(`${theme.fg("muted", "Effective pattern:")} ${replaceTabs(joinPatterns(this.effectivePatterns))}`);
		lines.push(
			`${theme.fg("muted", "Effective:")} ${this.effectiveResolution ? this.#formatResolution(this.effectiveResolution) : theme.fg("dim", "(unresolved)")}`,
		);
		// WHICH setting decided, always shown. Four layers can name a subagent's
		// model, and an operator who cannot see which one answered has no way to
		// tell an override that took effect from one that was outranked — the exact
		// confusion this settings area exists to end.
		if (this.effectiveModel) {
			lines.push(
				`${theme.fg("muted", "Decided by:")} ${theme.fg("dim", subagentModelSourceLabel(this.effectiveModel.source, this.agent.name))}`,
			);
		}
		if (this.effectiveModel?.unresolved) {
			const { source, value } = this.effectiveModel.unresolved;
			lines.push(
				theme.fg(
					"error",
					`${subagentModelSourceLabel(source, this.agent.name)} is set to "${value}", which matches no available model. Spawns will refuse until this is fixed.`,
				),
			);
		}

		if (this.agent.filePath) {
			lines.push("");
			lines.push(theme.fg("muted", "Path:"));
			lines.push(theme.fg("dim", `  ${replaceTabs(shortenPath(this.agent.filePath))}`));
		}

		if (this.agent.description) {
			lines.push("");
			lines.push(theme.fg("muted", "Description:"));
			for (const wrapped of wrapTextWithAnsi(replaceTabs(this.agent.description), Math.max(10, width - 2))) {
				lines.push(truncateToWidth(wrapped, width));
			}
		}

		return lines;
	}

	#formatResolution(resolution: ModelResolution): string {
		return formatResolution(resolution);
	}

	invalidate(): void {}
}

class TwoColumnBody implements Component {
	constructor(
		private readonly leftPane: AgentListPane,
		private readonly rightPane: AgentInspectorPane,
		private readonly maxHeight: number,
	) {}

	render(width: number): readonly string[] {
		const leftWidth = Math.floor(width * 0.5);
		const rightWidth = width - leftWidth - 3;
		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);
		const lineCount = this.maxHeight;
		const out: string[] = [];
		const separator = theme.fg("dim", ` ${theme.boxSharp.vertical} `);

		for (let i = 0; i < lineCount; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			out.push(leftPadded + separator + right);
		}

		return out;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}

export class AgentDashboard extends Container {
	#settingsManager: Settings | null = null;
	#allAgents: DashboardAgent[] = [];
	#filteredAgents: DashboardAgent[] = [];
	#tabs: SourceTab[] = [{ id: "all", label: "All", count: 0 }];
	#activeTabIndex = 0;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#searchQuery = "";
	#loading = true;
	#loadError: string | null = null;
	#notice: string | null = null;
	#builtRows = -1;
	#builtCols = -1;
	/** Content-column width inside the ModalShell card, refreshed every render. */
	#contentWidth = 80;
	/** Card height budget inside the ModalShell card, refreshed every render. */
	#modalHeight = 20;
	/**
	 * Body rows the card will actually show, from the shell's own plan and
	 * refreshed every render. `#computeBodyHeight` sizes the panes against this
	 * rather than restating the chrome arithmetic, which is how the last row got
	 * dropped: a body longer than the budget is truncated with no error.
	 */
	#bodyBudget = 11;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;

	#editInput: Input | null = null;
	#editingAgentName: string | null = null;

	#createInput: Editor | null = null;
	#createDescription = "";
	#createScope: AgentScope = "project";
	#createGenerating = false;
	#createSpec: GeneratedAgentSpec | null = null;
	#createError: string | null = null;
	#createStreamingText = "";

	onClose?: () => void;
	onRequestRender?: () => void;
	#reveal = new ModalRevealDriver();

	private constructor(
		private readonly cwd: string,
		private readonly settings: Settings | null,
		private readonly terminalHeight: number,
		private readonly modelContext: AgentDashboardModelContext,
	) {
		super();
	}

	static async create(
		cwd: string,
		settings: Settings | null = null,
		terminalHeight?: number,
		modelContext: AgentDashboardModelContext = {},
		/** Play the open unfold (TOUCH-5). Show site decides via modalRevealEnabled(). */
		reveal?: boolean,
	): Promise<AgentDashboard> {
		const dashboard = new AgentDashboard(cwd, settings, terminalHeight ?? process.stdout.rows ?? 24, modelContext);
		if (reveal) {
			dashboard.#reveal.start(() => dashboard.onRequestRender?.());
		}
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		this.#settingsManager = this.settings ?? (await Settings.init());
		await this.#reloadData();
		this.#buildLayout();
	}

	async #reloadData(): Promise<void> {
		this.#loading = true;
		this.#loadError = null;
		this.#buildLayout();

		try {
			const selectedName = this.#selectedAgent()?.name;
			const activeTabId = this.#tabs[this.#activeTabIndex]?.id ?? "all";
			const { agents } = await discoverAgents(this.cwd);
			const settings = this.#settingsManager;

			this.#allAgents = agents
				.slice()
				.sort((a, b) => {
					const sourceCmp = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
					if (sourceCmp !== 0) return sourceCmp;
					return a.name.localeCompare(b.name);
				})
				.map(agent => {
					const row = settings ? subagentSettingsFor(settings, agent.name) : {};
					return {
						...agent,
						// Carried through verbatim, `undefined` included: an absent row is a
						// third state (the shipped default), not a synonym for off.
						enabled: row.enabled,
						overrideModel: row.model?.trim() || undefined,
					};
				});

			this.#tabs = this.#buildTabs(this.#allAgents);
			const nextTabIndex = this.#tabs.findIndex(tab => tab.id === activeTabId);
			this.#activeTabIndex = nextTabIndex >= 0 ? nextTabIndex : 0;
			this.#applyFilters();

			if (selectedName) {
				const idx = this.#filteredAgents.findIndex(agent => agent.name === selectedName);
				if (idx >= 0) {
					this.#selectedIndex = idx;
				}
			}
			this.#clampSelection();
		} catch (error) {
			this.#allAgents = [];
			this.#filteredAgents = [];
			this.#tabs = [{ id: "all", label: "All", count: 0 }];
			this.#activeTabIndex = 0;
			this.#selectedIndex = 0;
			this.#scrollOffset = 0;
			this.#loadError = errorMessage(error);
		} finally {
			this.#loading = false;
			this.#rebuildAndRender();
		}
	}

	#buildTabs(agents: DashboardAgent[]): SourceTab[] {
		const tabs: SourceTab[] = [{ id: "all", label: "All", count: agents.length }];
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };

		for (const agent of agents) {
			counts[agent.source] += 1;
		}

		for (const source of ["project", "user", "bundled"] as const) {
			if (counts[source] > 0) {
				tabs.push({ id: source, label: SOURCE_LABEL[source], count: counts[source] });
			}
		}

		return tabs;
	}

	#selectedAgent(): DashboardAgent | null {
		return this.#filteredAgents[this.#selectedIndex] ?? null;
	}

	#applyFilters(): void {
		const activeTab = this.#tabs[this.#activeTabIndex] ?? this.#tabs[0];
		const tabFiltered =
			activeTab.id === "all" ? this.#allAgents : this.#allAgents.filter(agent => agent.source === activeTab.id);

		if (!this.#searchQuery) {
			this.#filteredAgents = tabFiltered;
		} else {
			this.#filteredAgents = tabFiltered.filter(agent => matchAgent(agent, this.#searchQuery));
		}

		this.#clampSelection();
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.terminalHeight || 24;
	}

	#noticeBlockLines(): number {
		if (!this.#notice) return 0;
		return wrapTextWithAnsi(theme.fg("success", replaceTabs(this.#notice)), this.#contentWidth).length + 1;
	}

	/** Height budget for the two-column body, sized to the ModalShell card. */
	#computeBodyHeight(): number {
		// Chrome inside the card: tab bar + spacer (2), plus an optional notice
		// block. ModalShell owns everything outside the body, and how much that
		// is comes from {@link #bodyBudget}, which render() takes from the shell.
		// The `- 8` here was one row short of the truth (the card reserves NINE at
		// this sizing: top border, vPad above AND below the body, footer divider,
		// two footer lines, bottom border), so the dashboard handed the shell a
		// body one row too long and the shell silently dropped the last one.
		const preRows = 2 + this.#noticeBlockLines();
		return Math.max(1, this.#bodyBudget - preRows);
	}

	#getMaxVisibleItems(): number {
		// List pane chrome inside the body: search line, blank line, count line.
		return Math.max(3, this.#computeBodyHeight() - 3);
	}

	#currentShortcuts(): readonly ModalShortcut[] {
		if (this.#createSpec || this.#createInput || this.#createGenerating || this.#editInput) {
			return AGENT_SUBVIEW_SHORTCUTS;
		}
		return AGENT_LIST_SHORTCUTS;
	}

	/**
	 * Floating ModalShell card: titled chrome, tab bar, two-column body (or
	 * create/edit sub-view), centered shortcut chips. Transcript visible around
	 * the card (host overlay is fullscreen so the alt-screen + mouse tracking
	 * stay active for the card's lifetime).
	 */
	override render(width: number): readonly string[] {
		const height = Math.max(14, this.#terminalRows());
		// The create/edit sub-views run taller than a plain list, so reclaim
		// margin a bit earlier than the sibling dashboards' `height < 24`.
		const sizing = withCompact(MODAL_SIZING_LARGE, height <= 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		this.#contentWidth = dims.contentWidth;
		this.#modalHeight = dims.modalHeight;
		const shortcuts = this.#currentShortcuts();
		this.#bodyBudget = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		}).maxBodyRows;
		// Rebuild when terminal geometry changes so the card re-fits on resize.
		if (height !== this.#builtRows || dims.contentWidth !== this.#builtCols) {
			this.#buildLayout();
		}

		const body = super.render(dims.contentWidth);
		const shell = renderModalShell({
			title: "Agent Control Center",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});

		this.#shellGeometry = shell.geometry;
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	#clampSelection(): void {
		const next = clampSelection(
			this.#selectedIndex,
			this.#scrollOffset,
			this.#filteredAgents.length,
			this.#getMaxVisibleItems(),
		);
		this.#selectedIndex = next.selectedIndex;
		this.#scrollOffset = next.scrollOffset;
	}

	/**
	 * Write the whole Agents table back: one row per agent, holding only what
	 * differs from the shipped default.
	 *
	 * Both the enable flag and the per-agent model live in the SAME row
	 * (`subagent.agents.<name>`), so this is the one writer. Splitting them across
	 * two settings — a disabled-name list and a name→model map — is what let an
	 * agent's model survive invisibly while the agent looked off, and made the
	 * dashboard and the spawn path read different sources.
	 */
	#persistAgentRows(): void {
		const settings = this.#settingsManager;
		if (!settings) return;
		const rows: Record<string, SubagentAgentSettings> = {};
		for (const agent of this.#allAgents) {
			const row: SubagentAgentSettings = {};
			// An agent left at its shipped default writes no `enabled` key at all, so
			// a later change to that default reaches every install that never chose.
			if (agent.enabled !== undefined) row.enabled = agent.enabled;
			const model = agent.overrideModel?.trim();
			if (model) row.model = model;
			const existing = settings ? subagentSettingsFor(settings, agent.name) : {};
			if (existing.thinkingLevel) row.thinkingLevel = existing.thinkingLevel;
			if (Object.keys(row).length > 0) rows[agent.name] = row;
		}
		settings.set("subagent.agents", rows);
	}

	/**
	 * Cycle this agent through the three states `space` can express: the shipped
	 * default, offered to the model, blocked outright.
	 *
	 * A two-state toggle cannot say all three, and the middle one matters: a bundled
	 * specialist at its default is kept out of the tool description (that is the
	 * token saving) yet still runs when `/review` or you name it. Blocking is a
	 * separate, stronger choice, and it must be reachable from here rather than only
	 * by hand-editing `config.yml`.
	 */
	#toggleSelectedAgent(): void {
		const selected = this.#selectedAgent();
		if (!selected) return;
		selected.enabled = nextSubagentEnableValue(selected.enabled);
		this.#persistAgentRows();
		this.#buildLayout();
	}

	#beginModelEdit(): void {
		const selected = this.#selectedAgent();
		if (!selected) return;
		this.#createError = null;
		this.#editingAgentName = selected.name;
		this.#editInput = new Input();
		if (selected.overrideModel) {
			this.#editInput.setValue(selected.overrideModel);
		}
		this.#editInput.onSubmit = value => {
			this.#saveModelOverride(value);
		};
		this.#buildLayout();
	}

	#saveModelOverride(rawValue: string): void {
		if (!this.#editingAgentName) return;
		const selected = this.#allAgents.find(agent => agent.name === this.#editingAgentName);
		if (!selected) return;
		const value = rawValue.trim();
		selected.overrideModel = value || undefined;
		this.#persistAgentRows();
		this.#editingAgentName = null;
		this.#editInput = null;
		this.#applyFilters();
		this.#notice = `Updated model override for ${selected.name}`;
		this.#buildLayout();
	}

	#cancelModelEdit(): void {
		this.#editingAgentName = null;
		this.#editInput = null;
		this.#buildLayout();
	}

	#beginCreateFlow(): void {
		if (this.#createGenerating) return;
		this.#createError = null;
		this.#createSpec = null;
		this.#createDescription = "";
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("> ");
		editor.setMaxHeight(clampLow(this.#bodyBudget - 3, 3, 8));
		editor.disableSubmit = true;
		editor.onChange = value => {
			this.#createDescription = value;
		};
		this.#createInput = editor;
		this.#buildLayout();
	}

	#clearCreateFlow(): void {
		this.#createInput = null;
		this.#createDescription = "";
		this.#createGenerating = false;
		this.#createSpec = null;
		this.#createError = null;
		this.#createStreamingText = "";
	}

	#toggleCreateScope(): void {
		this.#createScope = this.#createScope === "project" ? "user" : "project";
		this.#buildLayout();
	}

	#submitCreateDescription(): void {
		if (!this.#createInput || this.#createGenerating) return;
		const description = this.#createInput.getExpandedText();
		this.#createDescription = description;
		void this.#generateAgentFromDescription(description);
	}

	#insertCreateNewline(): void {
		if (!this.#createInput || this.#createGenerating) return;
		this.#createInput.handleInput("\n");
		this.#createDescription = this.#createInput.getExpandedText();
		this.#buildLayout();
	}

	async #generateAgentFromDescription(rawDescription: string): Promise<void> {
		const description = rawDescription.trim();
		this.#createDescription = description;
		if (!description) {
			this.#createError = "Description is required.";
			this.#buildLayout();
			return;
		}

		this.#createGenerating = true;
		this.#createError = null;
		this.#createSpec = null;
		this.#createStreamingText = "";
		this.#buildLayout();

		try {
			const spec = await this.#runAgentCreationArchitect(description);
			this.#createSpec = spec;
			this.#notice = null;
		} catch (error) {
			this.#createError = errorMessage(error);
		} finally {
			this.#createGenerating = false;
			this.#rebuildAndRender();
		}
	}

	async #runAgentCreationArchitect(description: string): Promise<GeneratedAgentSpec> {
		const modelRegistry = this.modelContext.modelRegistry;
		if (!modelRegistry) {
			throw new Error("Model registry unavailable in current session.");
		}
		await modelRegistry.refresh();

		const settings = this.#settingsManager ?? undefined;
		const modelPatterns = resolveConfiguredModelPatterns(
			this.modelContext.activeModelPattern ??
				this.modelContext.defaultModelPattern ??
				settings?.getModelRole(DEFAULT_MODEL_SLOT),
			settings,
		);
		const { model } = resolveModelOverride(modelPatterns, modelRegistry, settings);
		const fallbackModel = modelRegistry.getAvailable()[0];
		const selectedModel = model ?? fallbackModel;
		if (!selectedModel) {
			throw new Error("No available model to generate agent specification.");
		}

		const systemPrompt = prompt.render(PROMPTS["subagent/agent-creation-architect"].text, {});
		const userPrompt = prompt.render(PROMPTS["subagent/agent-creation-user"].text, { request: description });

		const { session } = await createAgentSession({
			cwd: this.cwd,
			authStorage: modelRegistry.authStorage,
			modelRegistry,
			settings,
			model: selectedModel,
			systemPrompt: [systemPrompt],
			hasUI: false,
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			toolNames: ["__none__"],
			customTools: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const unsubscribe = session.subscribe(event => {
			if (event.type === "message_update" && "assistantMessageEvent" in event) {
				const ame = event.assistantMessageEvent;
				if (ame.type === "text_delta") {
					this.#createStreamingText += ame.delta;
					this.#rebuildAndRender();
				}
			}
		});

		try {
			await session.prompt(userPrompt, { expandPromptTemplates: false });
			const raw = extractAssistantText(session.state.messages);
			if (!raw) {
				throw new Error("No response returned by agent creation architect.");
			}
			return parseGeneratedAgentSpec(raw);
		} finally {
			unsubscribe();
			await session.dispose();
		}
	}

	async #saveGeneratedAgent(): Promise<void> {
		const spec = this.#createSpec;
		if (!spec) return;

		const dirs = getConfigDirs("agents", {
			user: this.#createScope === "user",
			project: this.#createScope === "project",
			cwd: this.cwd,
		});
		const targetDir = dirs[0]?.path;
		if (!targetDir) {
			throw new Error(`Cannot resolve ${this.#createScope} agents directory.`);
		}

		const filePath = path.join(targetDir, `${spec.identifier}.md`);
		try {
			await fs.stat(filePath);
			throw new Error(`Agent file already exists: ${shortenPath(filePath)}`);
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}

		const frontmatter = YAML.stringify(
			{
				name: spec.identifier,
				description: spec.whenToUse,
			},
			null,
			2,
		).trimEnd();
		const content = `---\n${frontmatter}\n---\n\n${spec.systemPrompt.trim()}\n`;
		await Bun.write(filePath, content);
		await this.#reloadData();
		this.#clearCreateFlow();
		this.#notice = `Created agent ${spec.identifier} at ${shortenPath(filePath)}`;
		this.#rebuildAndRender();
	}

	#getModelSuggestions(input: string): string[] {
		const modelRegistry = this.modelContext.modelRegistry;
		if (!modelRegistry) return [];
		const query = input.trim().toLowerCase();
		if (!query) return [];
		const available = modelRegistry.getAvailable();
		const seen = new Set<string>();
		const matches: string[] = [];
		for (const model of available) {
			const full = `${model.provider}/${model.id}`;
			if (seen.has(full)) continue;
			if (!full.toLowerCase().includes(query)) continue;
			seen.add(full);
			matches.push(full);
			if (matches.length >= 5) break;
		}
		return matches;
	}

	#switchTab(direction: 1 | -1): void {
		if (this.#tabs.length === 0) return;
		this.#activeTabIndex = (this.#activeTabIndex + direction + this.#tabs.length) % this.#tabs.length;
		this.#selectedIndex = 0;
		this.#scrollOffset = 0;
		this.#applyFilters();
		this.#buildLayout();
	}

	#moveSelection(delta: -1 | 1): void {
		if (this.#filteredAgents.length === 0) return;
		this.#selectedIndex = clampLow(this.#selectedIndex + delta, 0, this.#filteredAgents.length - 1);
		this.#clampSelection();
		this.#buildLayout();
	}

	/** What this agent would run with no row of its own — the "default" shown beside an override. */
	#defaultModelFor(agent: DashboardAgent): ResolvedSubagentModel | undefined {
		const settings = this.#settingsManager;
		if (!settings) return undefined;
		return resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			activeModelPattern: this.modelContext.activeModelPattern,
			fallbackModelPattern: this.modelContext.defaultModelPattern,
			ignoreAgentRow: true,
		});
	}

	/** What this agent runs right now, honoring an in-progress edit before it is saved. */
	#effectiveModelFor(agent: DashboardAgent, draftOverride: string | undefined): ResolvedSubagentModel | undefined {
		const settings = this.#settingsManager;
		if (!settings) return undefined;
		return resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			draftModel: draftOverride,
			activeModelPattern: this.modelContext.activeModelPattern,
			fallbackModelPattern: this.modelContext.defaultModelPattern,
		});
	}

	#resolvePatterns(patterns: string[]): ModelResolution | undefined {
		const modelRegistry = this.modelContext.modelRegistry;
		if (!modelRegistry || patterns.length === 0) return undefined;
		const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(
			patterns,
			modelRegistry,
			this.#settingsManager ?? undefined,
		);
		if (!model) return undefined;
		return {
			resolved: formatModelString(model),
			thinkingLevel,
			explicitThinkingLevel,
		};
	}

	#renderTabBar(): string {
		const parts: string[] = [" "];
		for (let i = 0; i < this.#tabs.length; i++) {
			const tab = this.#tabs[i];
			const label = `${tab.label} (${tab.count})`;
			if (i === this.#activeTabIndex) {
				parts.push(theme.bg("selectedBg", ` ${label} `));
			} else {
				parts.push(theme.fg("muted", ` ${label} `));
			}
		}
		return parts.join("");
	}
	#renderCreateInput(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", " Create New Agent")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Describe what the new agent should do:"), 0, 0));
		this.addChild(new Spacer(1));
		if (this.#createInput) {
			this.#createInput.setMaxHeight(clampLow(this.#bodyBudget - 3, 3, 8));
			this.addChild(this.#createInput);
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `Scope: ${this.#createScope}`), 0, 0));
		if (this.#createGenerating) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("accent", "Generating agent specification..."), 0, 0));
			if (this.#createStreamingText) {
				this.addChild(new Spacer(1));
				const maxPreview = Math.max(3, this.#bodyBudget - 9);
				const contentWidth = Math.max(20, this.#contentWidth - 4);
				const wrappedLines: string[] = [];
				for (const raw of this.#createStreamingText.split("\n")) {
					for (const w of wrapTextWithAnsi(replaceTabs(raw), contentWidth)) {
						wrappedLines.push(w);
					}
				}
				const tail = wrappedLines.slice(-maxPreview);
				if (wrappedLines.length > maxPreview) {
					this.addChild(new Text(theme.fg("dim", `  ... ${wrappedLines.length - maxPreview} lines above`), 0, 0));
				}
				for (const line of tail) {
					this.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
				}
			}
		}
		if (this.#createError) {
			this.addChild(new Text(theme.fg("error", replaceTabs(this.#createError)), 0, 0));
		}
		this.addChild(new Spacer(1));
		const hints = this.#createGenerating
			? " Generating..."
			: " Ctrl+Q/Ctrl+Enter: generate  Enter: newline  Tab: toggle scope  Esc: cancel";
		this.addChild(new Text(theme.fg("dim", hints), 0, 0));
	}

	#renderCreateReview(): void {
		const spec = this.#createSpec;
		if (!spec) return;

		this.addChild(new Text(theme.bold(theme.fg("accent", " Review Generated Agent")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `Identifier: ${spec.identifier}`), 0, 0));
		this.addChild(new Text(theme.fg("muted", `Scope: ${this.#createScope}`), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "whenToUse:"), 0, 0));
		for (const line of wrapTextWithAnsi(replaceTabs(spec.whenToUse), Math.max(20, this.#contentWidth - 2)).slice(
			0,
			8,
		)) {
			this.addChild(new Text(truncateToWidth(line, this.#contentWidth - 2), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "systemPrompt preview:"), 0, 0));
		const promptWidth = Math.max(20, this.#contentWidth - 4);
		const wrappedPrompt: string[] = [];
		for (const raw of spec.systemPrompt.split("\n")) {
			for (const w of wrapTextWithAnsi(replaceTabs(raw), promptWidth)) {
				wrappedPrompt.push(w);
			}
		}
		const promptPreview = wrappedPrompt.slice(0, 10);
		for (const line of promptPreview) {
			this.addChild(new Text(`  ${line}`, 0, 0));
		}
		if (wrappedPrompt.length > promptPreview.length) {
			this.addChild(
				new Text(theme.fg("dim", `  ... ${wrappedPrompt.length - promptPreview.length} more lines`), 0, 0),
			);
		}
		if (this.#createError) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", replaceTabs(this.#createError)), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", " Enter: save  Tab: toggle scope  R: regenerate  Esc: cancel"), 0, 0));
	}

	/** Rebuild layout and request a TUI render pass (for use after async state changes). */
	#rebuildAndRender(): void {
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#buildLayout(): void {
		this.clear();
		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		if (this.#notice) {
			this.addChild(new Text(theme.fg("success", replaceTabs(this.#notice)), 0, 0));
			this.addChild(new Spacer(1));
		}

		if (this.#loading) {
			this.addChild(new Text(theme.fg("muted", "Loading agents..."), 0, 0));
			this.addChild(new Spacer(1));
		} else if (this.#loadError) {
			this.addChild(new Text(theme.fg("error", `Failed to load agents: ${replaceTabs(this.#loadError)}`), 0, 0));
			this.addChild(new Spacer(1));
		} else if (this.#createSpec) {
			this.#renderCreateReview();
		} else if (this.#createInput || this.#createGenerating) {
			this.#renderCreateInput();
		} else if (this.#editInput && this.#editingAgentName) {
			const editingAgent = this.#allAgents.find(agent => agent.name === this.#editingAgentName) ?? null;
			const draft = this.#editInput.getValue();
			const defaultPatterns = editingAgent ? (this.#defaultModelFor(editingAgent)?.patterns ?? []) : [];
			const defaultResolution = this.#resolvePatterns(defaultPatterns);
			const previewModel = editingAgent ? this.#effectiveModelFor(editingAgent, draft) : undefined;
			const previewPatterns = previewModel?.patterns ?? [];
			const previewResolution = this.#resolvePatterns(previewPatterns);
			const suggestions = this.#getModelSuggestions(draft);

			this.addChild(
				new Text(theme.bold(theme.fg("accent", `Model override: ${replaceTabs(this.#editingAgentName)}`)), 0, 0),
			);
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "Enter model pattern (empty clears override)"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.#editInput);
			this.addChild(new Spacer(1));

			this.addChild(
				new Text(theme.fg("muted", `Default pattern: ${replaceTabs(joinPatterns(defaultPatterns))}`), 0, 0),
			);
			this.addChild(
				new Text(
					`${theme.fg("muted", "Default resolves:")} ${defaultResolution ? formatResolution(defaultResolution) : theme.fg("dim", "(unresolved)")}`,
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					`${theme.fg("muted", "Preview effective:")} ${previewResolution ? formatResolution(previewResolution) : theme.fg("dim", "(unresolved)")}`,
					0,
					0,
				),
			);
			// Name the setting the preview came from. A pattern that looks wrong is
			// only actionable once you know which of the four layers produced it.
			if (previewModel && editingAgent) {
				this.addChild(
					new Text(
						`${theme.fg("muted", "Decided by:")} ${theme.fg("dim", subagentModelSourceLabel(previewModel.source, editingAgent.name))}`,
						0,
						0,
					),
				);
			}
			if (previewModel?.unresolved) {
				this.addChild(
					new Text(
						theme.fg(
							"error",
							`${subagentModelSourceLabel(previewModel.unresolved.source, this.#editingAgentName)} is set to "${previewModel.unresolved.value}", which matches no available model. Spawns will refuse until this is fixed.`,
						),
						0,
						0,
					),
				);
			}

			if (suggestions.length > 0) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("muted", "Suggestions:"), 0, 0));
				for (const suggestion of suggestions) {
					this.addChild(new Text(theme.fg("dim", `  ${suggestion}`), 0, 0));
				}
			}

			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", " Enter: save  Esc: cancel"), 0, 0));
		} else {
			const selected = this.#selectedAgent();
			const defaultModel = selected ? this.#defaultModelFor(selected) : undefined;
			const defaultPatterns = defaultModel?.patterns ?? [];
			const defaultResolution = this.#resolvePatterns(defaultPatterns);
			const effectiveModel = selected ? this.#effectiveModelFor(selected, selected.overrideModel) : undefined;
			const effectivePatterns = effectiveModel?.patterns ?? [];
			const effectiveResolution = this.#resolvePatterns(effectivePatterns);

			const listPane = new AgentListPane(
				this.#filteredAgents,
				this.#selectedIndex,
				this.#scrollOffset,
				this.#searchQuery,
				this.#getMaxVisibleItems(),
			);
			const inspector = new AgentInspectorPane(
				selected,
				defaultPatterns,
				defaultResolution,
				effectivePatterns,
				effectiveResolution,
				effectiveModel,
			);
			const bodyHeight = this.#computeBodyHeight();
			this.addChild(new TwoColumnBody(listPane, inspector, bodyHeight));
		}

		this.#builtRows = this.#terminalRows();
		this.#builtCols = this.#contentWidth;
	}

	/**
	 * Shared Esc/close-chrome behavior: cancel the innermost open sub-view
	 * (create review → create input → edit override → search), or close the
	 * whole dashboard. Shared by the Esc key path and the ModalShell `[x]`/
	 * click-outside mouse chrome so both dismiss the same layer.
	 */
	#handleEscape(): void {
		if (this.#createSpec) {
			this.#clearCreateFlow();
			this.#buildLayout();
			return;
		}
		if (this.#createInput || this.#createGenerating) {
			if (!this.#createGenerating) {
				this.#clearCreateFlow();
				this.#buildLayout();
			}
			return;
		}
		if (this.#editInput) {
			this.#cancelModelEdit();
			return;
		}
		if (this.#searchQuery.length > 0) {
			this.#searchQuery = "";
			this.#applyFilters();
			this.#buildLayout();
			return;
		}
		this.onClose?.();
	}

	/**
	 * Route an SGR mouse report against the last render's ModalShell geometry.
	 * Only chrome (close glyph, click-outside, footer chip hover) is wired;
	 * list/inspector selection stays keyboard-driven.
	 */
	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
				motion: event.motion,
				leftClick: event.leftClick,
			});
			if (chrome.kind === "hover-shortcut") {
				if (this.#hoveredShortcutId !== chrome.id) {
					this.#hoveredShortcutId = chrome.id;
					this.onRequestRender?.();
				}
				return true;
			}
			if (
				chrome.kind === "close" ||
				chrome.kind === "outside" ||
				(chrome.kind === "shortcut" && chrome.id === "close")
			) {
				this.#handleEscape();
				this.onRequestRender?.();
			}
			return true;
		});
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}

		if (this.#createSpec) {
			if (matchesAppInterrupt(data)) {
				this.#handleEscape();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				this.#toggleCreateScope();
				return;
			}
			if (data.toLowerCase() === "r") {
				void this.#generateAgentFromDescription(this.#createDescription);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				void this.#saveGeneratedAgent().catch(error => {
					this.#createError = errorMessage(error);
					this.#rebuildAndRender();
				});
				return;
			}
			return;
		}

		if (this.#createInput || this.#createGenerating) {
			if (matchesAppInterrupt(data)) {
				this.#handleEscape();
				return;
			}
			if (!this.#createGenerating && matchesAppFollowUp(data)) {
				this.#submitCreateDescription();
				return;
			}
			if (!this.#createGenerating && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n")) {
				this.#insertCreateNewline();
				return;
			}
			if (!this.#createGenerating && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
				this.#toggleCreateScope();
				return;
			}
			if (!this.#createGenerating && this.#createInput) {
				this.#createInput.handleInput(data);
				this.#createDescription = this.#createInput.getExpandedText();
				this.#buildLayout();
			}
			return;
		}

		if (this.#editInput) {
			if (matchesAppInterrupt(data)) {
				this.#handleEscape();
				return;
			}
			this.#editInput.handleInput(data);
			if (this.#editInput) {
				this.#buildLayout();
			}
			return;
		}

		if (matchesAppInterrupt(data)) {
			this.#handleEscape();
			return;
		}

		if (matchesKey(data, "ctrl+r")) {
			void this.#reloadData();
			return;
		}

		if (handleTabSwitchKey(data, direction => this.#switchTab(direction))) {
			return;
		}

		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#moveSelection(1);
			return;
		}

		if (data === " ") {
			this.#toggleSelectedAgent();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#beginModelEdit();
			return;
		}
		if (data.toLowerCase() === "n") {
			this.#beginCreateFlow();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#applyFilters();
				this.#buildLayout();
			}
			return;
		}

		const char = searchableChar(data);
		if (char !== null) {
			this.#searchQuery += char;
			this.#applyFilters();
			this.#buildLayout();
		}
	}
}

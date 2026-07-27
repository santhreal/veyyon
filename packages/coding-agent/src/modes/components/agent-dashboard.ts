/**
 * AgentDashboard - the Agent Control Center.
 *
 * Three views, one card:
 * - Live: every agent running in this process right now and what each is doing.
 *   Enter opens a lens on one agent; Esc leaves the lens.
 * - Room: every agent's turns interleaved into one conversation, the driving
 *   session labelled `Main` and each subagent under a stable call sign.
 * - Agents: the configuration list -- every discovered agent, enabled or not,
 *   with a one-line description, an enable toggle, and a model override.
 *
 * WHY THESE THREE. The top strip used to filter the configuration list by where
 * an agent's file lives (All / Project / User / Bundled). That is not something
 * anyone opens this card to find out -- it does not say whether an agent is on,
 * what it costs, or what it is doing -- and with a handful of agents installed
 * every tab showed nearly the same rows. The strip now switches between three
 * genuinely different questions, and the source of an agent survives as a dim
 * badge on its row, which is all it was ever worth.
 *
 * Controls (list views):
 * - Up/Down or j/k: move selection
 * - Tab / Shift+Tab or Left/Right: switch view
 * - Space: enable/disable selected agent (Agents view)
 * - Enter: open the lens (Live view) or edit the model override (Agents view)
 * - N: start agent creation flow (Agents view)
 * - Esc: leave the lens, clear the search, or close the card
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
import { clampLow, errorMessage, formatAge, isEnoent, prompt } from "@veyyon/utils";
import { YAML } from "bun";
import { getConfigDirs } from "../../config";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelString, resolveConfiguredModelPatterns, resolveModelOverride } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../../config/model-roles";
import { Settings } from "../../config/settings";
import type { SubagentAgentSettings } from "../../config/settings-domains/subagents";
import { subagentPrompts } from "../../prompts/subagent/rows";
import { AgentRegistry } from "../../registry/agent-registry";
import { createAgentSession } from "../../sdk";
import { parseSessionEntries } from "../../session/session-loader";
import { discoverAgents } from "../../task/discovery";
import {
	delegationBlockedNotice,
	nextSubagentEnableValue,
	type ResolvedSubagentModel,
	resolveDelegation,
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
	collectLiveAgents,
	type LiveAgent,
	MAIN_CALL_SIGN,
	mergeRoomMessages,
	type RoomMessage,
	roomMessagesFrom,
	runningAgents,
} from "./agent-activity";
import { agentStatusGlyph, agentStatusWord } from "./agent-status-display";
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

/** Which of the card's three views is showing. */
type ViewId = "live" | "room" | "agents";

interface ViewTab {
	id: ViewId;
	label: string;
	/** Rows behind the tab, so the strip says how much is there before you switch. */
	count: number;
}

const VIEW_ORDER: readonly ViewId[] = ["live", "room", "agents"];

type AgentScope = "project" | "user";

interface DashboardAgent extends AgentDefinition {
	/**
	 * The agent's `subagent.agents.<name>.enabled` value VERBATIM, including
	 * `undefined` for "no row".
	 *
	 * Two states are shown and three are stored: `true`, `false`, and "no row",
	 * which means the shipped default. The third is not a third BEHAVIOUR — a
	 * disabled agent is disabled, whichever way it got there — it is how an agent
	 * left alone keeps tracking the default if the default later changes. Writing
	 * it back verbatim is what stops the dashboard from inventing an explicit
	 * choice the operator never made.
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
	if (state === "on") {
		return { symbol: theme.fg("success", theme.status.enabled), label: theme.fg("success", label), dim: false };
	}
	// One disabled look, because there is one disabled meaning. The old vocabulary
	// had two — a warning-coloured "not offered (default)" and a dim "blocked" —
	// which spent the reader's attention on a distinction that changed nothing
	// about whether the agent runs.
	return { symbol: theme.fg("dim", theme.status.disabled), label: theme.fg("dim", label), dim: true };
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

/** ModalShell footer chips for the Agents (configuration) view. */
const AGENT_LIST_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "space toggle" },
	{ label: "enter override" },
	{ label: "n new agent" },
	{ label: "m model breakdown" },
	{ label: "left/right view" },
	{ label: "ctrl+r reload" },
	{ label: "esc close", clickable: true, id: "close" },
];

/** ModalShell footer chips for the Live roster. */
const LIVE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter open lens" },
	{ label: "left/right view" },
	{ label: "esc close", clickable: true, id: "close" },
];

/** ModalShell footer chips inside a single agent's lens. */
const LENS_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "esc back to live", clickable: true, id: "close" },
	{ label: "left/right view" },
];

/** ModalShell footer chips for the Room transcript. */
const ROOM_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down scroll" },
	{ label: "left/right view" },
	{ label: "ctrl+r reload" },
	{ label: "esc close", clickable: true, id: "close" },
];

/**
 * Turns held in the Room view.
 *
 * A cap, not a page: the room reads from the bottom, so this bounds the work of
 * re-reading every agent's session file on refresh without ever hiding the part
 * being watched. Older turns stay in the full transcript, which is what the
 * Agent Hub's per-agent viewer is for.
 */
const ROOM_MESSAGE_LIMIT = 300;

/** Lines of one turn shown in the Room before it is elided. */
const ROOM_TURN_PREVIEW_LINES = 6;

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
		/** Show the four-stage model resolution walk (the `m` key). */
		private readonly showBreakdown: boolean,
	) {}

	render(width: number): readonly string[] {
		if (!this.agent) {
			return [theme.fg("muted", "Select an agent"), theme.fg("dim", "to inspect settings")];
		}

		const lines: string[] = [];
		const display = enableStateDisplay(enableStateOf(this.agent));

		lines.push(theme.bold(theme.fg("accent", replaceTabs(this.agent.name))));
		lines.push(theme.fg("dim", `${SOURCE_LABEL[this.agent.source]} agent`));
		lines.push("");
		lines.push(`${display.symbol} ${display.label}`);
		lines.push("");

		// WHAT IT IS FOR, high and in full. A specialist has to be discoverable
		// BEFORE it is enabled, and the description is the only thing that says
		// what it does — it used to sit last, under seven lines of model plumbing,
		// where an operator deciding whether to turn the agent on never reached it.
		if (this.agent.description) {
			for (const wrapped of wrapTextWithAnsi(replaceTabs(this.agent.description), Math.max(10, width - 2))) {
				lines.push(truncateToWidth(wrapped, width));
			}
			lines.push("");
		}

		// ONE model line: the model it will run on, and the setting that decided.
		// The pane used to spend five lines walking the same fact through its
		// resolution stages — `Default pattern`, `Default resolves`, `Override`,
		// `Effective pattern`, `Effective` — which on a stock install are pairwise
		// identical, so the reader paid five lines to learn one thing.
		const runsOn = this.effectiveResolution
			? this.#formatResolution(this.effectiveResolution)
			: theme.fg("dim", "(unresolved)");
		const decidedBy = this.effectiveModel
			? theme.fg("dim", ` · ${subagentModelSourceLabel(this.effectiveModel.source, this.agent.name)}`)
			: "";
		lines.push(`${theme.fg("muted", "Runs on:")} ${runsOn}${decidedBy}`);

		if (this.effectiveModel?.unresolved) {
			const { source, value } = this.effectiveModel.unresolved;
			lines.push(
				theme.fg(
					"error",
					`${subagentModelSourceLabel(source, this.agent.name)} is set to "${value}", which matches no available model. Spawns will refuse until this is fixed.`,
				),
			);
		}

		// The breakdown stays reachable, behind a key. It earns its space exactly
		// when the stages DISAGREE — an override that took effect, or one that was
		// outranked by a higher layer — and that is a question you ask on purpose.
		if (this.showBreakdown) {
			lines.push("");
			lines.push(`${theme.fg("muted", "Default pattern:")} ${replaceTabs(joinPatterns(this.defaultPatterns))}`);
			lines.push(
				`${theme.fg("muted", "Default resolves:")} ${this.defaultResolution ? this.#formatResolution(this.defaultResolution) : theme.fg("dim", "(unresolved)")}`,
			);
			lines.push(
				`${theme.fg("muted", "Override:")} ${this.agent.overrideModel ? theme.fg("warning", replaceTabs(this.agent.overrideModel)) : theme.fg("dim", "(none)")}`,
			);
			lines.push(`${theme.fg("muted", "Effective pattern:")} ${replaceTabs(joinPatterns(this.effectivePatterns))}`);
			if (this.agent.filePath) {
				lines.push(
					`${theme.fg("muted", "Path:")} ${theme.fg("dim", replaceTabs(shortenPath(this.agent.filePath)))}`,
				);
			}
			lines.push("");
			lines.push(theme.fg("dim", "m: hide model breakdown"));
		} else {
			lines.push("");
			lines.push(theme.fg("dim", "m: model breakdown"));
		}

		return lines;
	}

	#formatResolution(resolution: ModelResolution): string {
		return formatResolution(resolution);
	}

	invalidate(): void {}
}

/**
 * Seconds between two epoch-millisecond stamps, for {@link formatAge}.
 *
 * `formatAge` takes SECONDS and appends " ago" itself. Handing it milliseconds
 * showed a four-second-old agent as "1h ago" and a two-minute-old one as "1d
 * ago", and appending a second " ago" at the call site read as "51m ago ago".
 * One helper so both surfaces convert once and neither restates the unit.
 */
function ageSeconds(now: number, at: number): number {
	return Math.max(0, Math.round((now - at) / 1000));
}

/**
 * The Live roster: one row per agent that exists in this process right now.
 *
 * Deliberately NOT the configuration list. The old inspector listed every
 * discovered agent whether or not it had ever run, so a stock install showed
 * five specialists that were disabled and idle, presented with the same weight
 * as the one agent actually doing work. This pane only ever shows agents that
 * exist, which means a disabled specialist cannot appear in it at all -- not by
 * a filter that could drift, but because a disabled agent is never spawned and
 * so never registers.
 */
class LiveRosterPane implements Component {
	constructor(
		private readonly agents: readonly LiveAgent[],
		private readonly selectedIndex: number,
		private readonly scrollOffset: number,
		private readonly maxVisible: number,
		private readonly now: number,
	) {}

	render(width: number): readonly string[] {
		if (this.agents.length === 0) {
			return [
				theme.fg("muted", "  Nothing running."),
				"",
				theme.fg("dim", "  Subagents appear here the moment they spawn."),
				theme.fg("dim", "  Configure which ones the model may choose in the Agents view."),
			];
		}

		const rows: string[] = [];
		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.agents.length);
		for (let i = start; i < end; i++) {
			const agent = this.agents[i];
			const selected = i === this.selectedIndex;
			const glyph = agentStatusGlyph(agent.status);
			const name = theme.bold(replaceTabs(agent.callSign));
			const status = theme.fg("dim", agentStatusWord(agent.status));
			const age = theme.fg("dim", formatAge(ageSeconds(this.now, agent.lastActivity)));
			// The activity gist IS the answer to "what is it doing", so it gets the
			// rest of the row rather than a truncated column of its own.
			const doing = agent.activity
				? theme.fg("muted", replaceTabs(agent.activity))
				: theme.fg("dim", replaceTabs(agent.displayName));
			let line = ` ${glyph} ${name} ${status} ${age}  ${doing}`;
			if (selected) line = theme.bg("selectedBg", theme.fg("accent", line));
			rows.push(truncateToWidth(line, width));
		}

		const sv = new ScrollView(rows, {
			height: rows.length,
			scrollbar: "auto",
			totalRows: this.agents.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(this.scrollOffset);
		return sv.render(width);
	}

	invalidate(): void {}
}

/**
 * One agent, up close: the lens Enter opens over the Live roster.
 *
 * Everything here is already true somewhere else in the process -- the point is
 * that it is true in ONE place a reader can look at while the agent is running,
 * instead of spread across a status line count, a roster row, and a session file
 * path nobody has.
 */
class AgentLensPane implements Component {
	constructor(
		private readonly agent: LiveAgent,
		private readonly now: number,
	) {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const agent = this.agent;
		// The id only earns a place when it says something the call sign does not.
		// For the driving session the two are the same word, and `Main (Main)` reads
		// as a bug in the header.
		const id = agent.id === agent.callSign ? "" : ` ${theme.fg("dim", `(${replaceTabs(agent.id)})`)}`;
		lines.push(
			`${theme.bold(theme.fg("accent", replaceTabs(agent.callSign)))}${id}  ${agentStatusGlyph(agent.status)} ${agentStatusWord(agent.status)}`,
		);
		lines.push("");

		// WHAT IT IS DOING, first. The lens is opened mid-run to answer that one
		// question, and it used to sit below five lines of metadata -- which put it
		// past the card's body budget on a normal terminal, so the one line worth
		// opening the lens for was the line that got clipped off the bottom.
		// A finished agent has no current work, and the registry clears the gist when
		// it leaves `running`, so say that rather than leave the last thing it did
		// sitting there looking live.
		const doing = agent.activity ?? (agent.status === "running" ? "(no activity reported yet)" : "(finished)");
		for (const wrapped of wrapTextWithAnsi(replaceTabs(doing), Math.max(10, width - 2))) {
			lines.push(truncateToWidth(wrapped, width));
		}
		lines.push("");
		lines.push(`${theme.fg("muted", "Task:")} ${replaceTabs(agent.displayName)}`);
		lines.push("");

		lines.push(
			`${theme.fg("muted", "Model:")} ${agent.model ? replaceTabs(agent.model) : theme.fg("dim", "(unknown)")} ${theme.fg("dim", `· ${agent.kind}`)}`,
		);
		lines.push(
			`${theme.fg("muted", "Started:")} ${formatAge(ageSeconds(this.now, agent.createdAt))} ${theme.fg("dim", "·")} ${theme.fg("muted", "last activity")} ${formatAge(ageSeconds(this.now, agent.lastActivity))}`,
		);
		if (agent.sessionFile) {
			lines.push(
				`${theme.fg("muted", "Transcript:")} ${theme.fg("dim", replaceTabs(shortenPath(agent.sessionFile)))}`,
			);
		}
		return lines;
	}

	invalidate(): void {}
}

/**
 * The Room: every agent's turns in one conversation.
 *
 * The tab this replaced filtered the configuration list down to "Bundled",
 * which told you which agents shipped with the product -- a fact that never
 * changes and that nobody needs a tab for. A multi-agent run, on the other
 * hand, is genuinely hard to follow: each subagent's words live in its own
 * session file, and the only way to read the run as it happened was to open
 * them one at a time. This is that run as a single thread, each speaker under
 * the call sign the Live roster gives them.
 */
class RoomPane implements Component {
	constructor(
		private readonly messages: readonly RoomMessage[],
		/**
		 * Rows scrolled past, or `"tail"` for "stay on the newest".
		 *
		 * `"tail"` is a state, not the number that happens to mean the bottom right
		 * now. How many rows a room occupies depends on the width it wraps at and the
		 * height it is measured against, and both are only final at RENDER time -- a
		 * number computed earlier (when the transcript read finished, at a stale card
		 * geometry) put the view four turns short of the end, under a scrollbar drawn
		 * at the bottom. So the tail resolves here, where the rows exist.
		 */
		private readonly scrollOffset: number | "tail",
		private readonly maxVisible: number,
		private readonly loading: boolean,
		/** Report the resolved start row back, so scrolling up has a number to leave from. */
		private readonly onResolvedStart?: (start: number) => void,
	) {}

	/** Rendered rows for the whole room, before scrolling. Shared by render and the scroll bounds. */
	static layout(messages: readonly RoomMessage[], width: number): string[] {
		const rows: string[] = [];
		let lastSpeaker: string | null = null;
		for (const message of messages) {
			// One header per consecutive run by the same speaker: a name repeated
			// above every turn is how a chat log turns into a wall.
			if (message.speaker !== lastSpeaker) {
				if (rows.length > 0) rows.push("");
				// The driving session is the one speaker a reader needs to pick out at a
				// glance -- it is where their own words are, and where the run is being
				// steered from -- so it is bold and accented while the call signs stay
				// muted. Rendering both bold made every header look the same, which is
				// the failure mode of a chat log with six participants.
				const who =
					message.speaker === MAIN_CALL_SIGN
						? theme.bold(theme.fg("accent", message.speaker))
						: theme.fg("muted", message.speaker);
				const role = theme.fg("dim", message.role === "user" ? "prompt" : "says");
				rows.push(`${who} ${role}`);
				lastSpeaker = message.speaker;
			}
			const wrapped: string[] = [];
			for (const raw of message.text.split("\n")) {
				for (const line of wrapTextWithAnsi(replaceTabs(raw), Math.max(10, width - 4))) {
					wrapped.push(line);
				}
			}
			const shown = wrapped.slice(0, ROOM_TURN_PREVIEW_LINES);
			for (const line of shown) rows.push(truncateToWidth(`  ${line}`, width));
			if (wrapped.length > shown.length) {
				rows.push(theme.fg("dim", `  … ${wrapped.length - shown.length} more lines`));
			}
		}
		return rows;
	}

	render(width: number): readonly string[] {
		if (this.loading) return [theme.fg("muted", "  Reading transcripts…")];
		if (this.messages.length === 0) {
			return [
				theme.fg("muted", "  Nothing said yet."),
				"",
				theme.fg("dim", "  Every agent's turns land here as one conversation,"),
				theme.fg("dim", `  the driving session as ${MAIN_CALL_SIGN} and each subagent under a call sign.`),
			];
		}
		const rows = RoomPane.layout(this.messages, width);
		// Pre-sliced, because passing `totalRows` puts ScrollView in the mode where
		// the CALLER windows and the component only draws the bar. Handing it the
		// whole room with an offset set rendered the first screen under a scrollbar
		// parked at the bottom: the bar said "you are at the end" over the opening
		// of the conversation.
		const maxStart = Math.max(0, rows.length - this.maxVisible);
		const start = this.scrollOffset === "tail" ? maxStart : Math.min(this.scrollOffset, maxStart);
		this.onResolvedStart?.(start);
		const windowed = rows.slice(start, start + this.maxVisible);
		const sv = new ScrollView(windowed, {
			height: windowed.length,
			scrollbar: "auto",
			totalRows: rows.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(start);
		return sv.render(width);
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
	#activeView: ViewId = "live";
	#selectedIndex = 0;
	#scrollOffset = 0;

	/** Live roster, refreshed from the process-global registry on every change. */
	#liveAgents: LiveAgent[] = [];
	#liveSelectedIndex = 0;
	#liveScrollOffset = 0;
	/** Agent id the lens is open on, or null while the roster is showing. */
	#lensAgentId: string | null = null;
	#registryUnsubscribe: (() => void) | null = null;

	#roomMessages: RoomMessage[] = [];
	/** Rows scrolled past, or `"tail"` while the room follows the newest turn. */
	#roomScrollOffset: number | "tail" = "tail";
	/** Start row the pane last resolved, so leaving the tail has a number to leave from. */
	#roomResolvedStart = 0;
	#roomLoading = false;
	#roomError: string | null = null;
	/**
	 * Room reads are serialized by generation, not cancelled.
	 *
	 * Reading every agent's session file is async, so a second refresh can start
	 * before the first finishes and land its (older) result last. The generation
	 * counter makes a stale read drop its own result instead of overwriting a
	 * newer one, which would show a room that silently rewinds.
	 */
	#roomGeneration = 0;

	/**
	 * Whether the inspector walks the four model-resolution stages.
	 *
	 * Off by default and sticky while the card is open: someone comparing an
	 * override across several agents wants it open for all of them, and someone
	 * who never needs it never sees it.
	 */
	#showModelBreakdown = false;
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
		this.#refreshLiveAgents();
		// The card opens on whatever there is to see. With a subagent in flight the
		// live picture is the reason it was opened; with nothing running the card is
		// being used to configure, so it opens on the configuration list. Nothing is
		// hidden either way — the strip shows all three views with their counts.
		this.#activeView = this.#liveAgents.some(agent => agent.status === "running") ? "live" : "agents";
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => {
			this.#refreshLiveAgents();
			this.#rebuildAndRender();
		});
		await this.#reloadData();
		this.#buildLayout();
	}

	/**
	 * Drop the registry subscription.
	 *
	 * The registry is process-global and outlives every card opened against it, so
	 * a card that closed without unsubscribing would keep rebuilding a layout
	 * nobody is looking at for the rest of the session, once per agent event.
	 */
	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = null;
	}

	#refreshLiveAgents(): void {
		this.#liveAgents = collectLiveAgents(AgentRegistry.global().list());
		if (this.#lensAgentId && !this.#liveAgents.some(agent => agent.id === this.#lensAgentId)) {
			// The agent the lens was open on was released. Fall back to the roster
			// rather than render a lens over nothing.
			this.#lensAgentId = null;
		}
		this.#liveSelectedIndex = clampLow(this.#liveSelectedIndex, 0, Math.max(0, this.#liveAgents.length - 1));
	}

	#lensAgent(): LiveAgent | null {
		if (!this.#lensAgentId) return null;
		return this.#liveAgents.find(agent => agent.id === this.#lensAgentId) ?? null;
	}

	/**
	 * Rebuild the room from every agent's session file.
	 *
	 * Read at the edge, merged by the pure helpers in `agent-activity`: a file
	 * that cannot be read contributes nothing and is reported, because a room
	 * silently missing one speaker's half of the conversation is worse than one
	 * that says a transcript could not be read.
	 */
	async #reloadRoom(): Promise<void> {
		const generation = ++this.#roomGeneration;
		this.#roomLoading = true;
		this.#roomError = null;
		this.#rebuildAndRender();

		const streams: RoomMessage[][] = [];
		const failed: string[] = [];
		for (const agent of this.#liveAgents) {
			if (!agent.sessionFile) continue;
			try {
				const content = await Bun.file(agent.sessionFile).text();
				streams.push(roomMessagesFrom(agent, parseSessionEntries(content)));
			} catch (error) {
				failed.push(`${agent.callSign}: ${errorMessage(error)}`);
			}
		}
		if (generation !== this.#roomGeneration) return;

		this.#roomMessages = mergeRoomMessages(streams, ROOM_MESSAGE_LIMIT);
		this.#roomError = failed.length > 0 ? `Could not read ${failed.length} transcript(s) — ${failed[0]}` : null;
		this.#roomLoading = false;
		// A conversation is read from the bottom, so a fresh room starts there --
		// as the STATE "tail", resolved at render time against the real geometry.
		this.#roomScrollOffset = "tail";
		this.#rebuildAndRender();
	}

	async #reloadData(): Promise<void> {
		this.#loading = true;
		this.#loadError = null;
		this.#buildLayout();

		try {
			const selectedName = this.#selectedAgent()?.name;
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
			this.#selectedIndex = 0;
			this.#scrollOffset = 0;
			this.#loadError = errorMessage(error);
		} finally {
			this.#loading = false;
			this.#rebuildAndRender();
		}
	}

	/**
	 * The view strip: three questions, with how much sits behind each.
	 *
	 * Live counts what is RUNNING rather than what is registered, because an idle
	 * or parked agent is history, and a count that includes history never returns
	 * to zero once the session has spawned anything.
	 */
	#viewTabs(): ViewTab[] {
		return [
			{ id: "live", label: "Live", count: runningAgents(this.#liveAgents).length },
			{ id: "room", label: "Room", count: this.#roomMessages.length },
			{ id: "agents", label: "Agents", count: this.#allAgents.length },
		];
	}

	#selectedAgent(): DashboardAgent | null {
		return this.#filteredAgents[this.#selectedIndex] ?? null;
	}

	/**
	 * Apply the search box to the configuration list.
	 *
	 * There is no source filter any more: every discovered agent is always in this
	 * list, and where its file came from is a dim badge on the row. Filtering by
	 * source hid agents behind a distinction that changes nothing about what they
	 * do, and the search box already covers the case where someone genuinely wants
	 * only their project's agents — `project` is one of the fields it matches.
	 */
	#applyFilters(): void {
		this.#filteredAgents = this.#searchQuery
			? this.#allAgents.filter(agent => matchAgent(agent, this.#searchQuery))
			: this.#allAgents;
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
		if (this.#activeView === "live") return this.#lensAgent() ? LENS_SHORTCUTS : LIVE_SHORTCUTS;
		if (this.#activeView === "room") return ROOM_SHORTCUTS;
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
	 * Turn this agent on or off. Two states, because there are two.
	 *
	 * This used to cycle three ways — shipped default, offered, blocked — and the
	 * middle stop was a state where the agent stayed out of the tool description
	 * "yet still runs when /review or you name it". That is what made the switch
	 * unreadable: a user pressing `space` until it said off had not turned it off.
	 * Enabled now means the model may choose this agent and disabled means it may
	 * not, and a `/` command that names an agent is granted for that turn by the
	 * command itself, so `/review` needs no state of its own here.
	 *
	 * The toggle always writes an explicit value rather than clearing back to the
	 * default: clearing would be a keypress that changes nothing a reader can see,
	 * and an explicit choice survives a change to the shipped default.
	 */
	#toggleSelectedAgent(): void {
		const selected = this.#selectedAgent();
		if (!selected) return;
		selected.enabled = nextSubagentEnableValue(selected, selected.enabled);
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

		const systemPrompt = prompt.render(subagentPrompts["subagent/agent-creation-architect"].text, {});
		const userPrompt = prompt.render(subagentPrompts["subagent/agent-creation-user"].text, { request: description });

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

	/**
	 * Move to the next view.
	 *
	 * Switching always leaves the lens: the lens is a layer inside Live, and
	 * coming back to Live to find yourself still inside an agent you opened
	 * several views ago is the kind of hidden state that makes Esc unpredictable.
	 */
	#switchView(direction: 1 | -1): void {
		const index = VIEW_ORDER.indexOf(this.#activeView);
		this.#activeView = VIEW_ORDER[(index + direction + VIEW_ORDER.length) % VIEW_ORDER.length];
		this.#lensAgentId = null;
		if (this.#activeView === "live") this.#refreshLiveAgents();
		if (this.#activeView === "room" && !this.#roomLoading && this.#roomMessages.length === 0) {
			void this.#reloadRoom();
		}
		this.#buildLayout();
	}

	#moveSelection(delta: -1 | 1): void {
		if (this.#activeView === "live") {
			if (this.#liveAgents.length === 0) return;
			this.#liveSelectedIndex = clampLow(this.#liveSelectedIndex + delta, 0, this.#liveAgents.length - 1);
			const next = clampSelection(
				this.#liveSelectedIndex,
				this.#liveScrollOffset,
				this.#liveAgents.length,
				this.#computeBodyHeight(),
			);
			this.#liveSelectedIndex = next.selectedIndex;
			this.#liveScrollOffset = next.scrollOffset;
			this.#buildLayout();
			return;
		}
		if (this.#activeView === "room") {
			// Leaving the tail starts from wherever the tail actually resolved to,
			// which only the pane knows: scrolling up one row from the bottom must
			// move one row, not jump to a number computed at some earlier geometry.
			const from = this.#roomScrollOffset === "tail" ? this.#roomResolvedStart : this.#roomScrollOffset;
			const next = clampLow(from + delta, 0, Number.MAX_SAFE_INTEGER);
			this.#roomScrollOffset = next >= this.#roomResolvedStart && delta > 0 ? "tail" : next;
			this.#buildLayout();
			return;
		}
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
		for (const tab of this.#viewTabs()) {
			const label = `${tab.label} (${tab.count})`;
			if (tab.id === this.#activeView) {
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

	/**
	 * One sentence when nothing will be delegated, from the ONE resolver that
	 * reads both deciding settings, or `undefined` when delegation is possible.
	 */
	#delegationNotice(): string | undefined {
		const settings = this.#settingsManager;
		if (!settings) return undefined;
		const enabled = this.#allAgents.filter(agent => enableStateOf(agent) === "on").map(agent => agent.name);
		return delegationBlockedNotice(resolveDelegation(settings, enabled));
	}

	/** Live roster, or the lens when one is open on a single agent. */
	#buildLiveView(): void {
		const lens = this.#lensAgent();
		const now = Date.now();
		if (lens) {
			this.addChild(new AgentLensPane(lens, now));
			return;
		}
		this.addChild(
			new LiveRosterPane(
				this.#liveAgents,
				this.#liveSelectedIndex,
				this.#liveScrollOffset,
				this.#computeBodyHeight(),
				now,
			),
		);
	}

	/** The merged conversation, scrolled to wherever the reader left it. */
	#buildRoomView(): void {
		if (this.#roomError) {
			this.addChild(new Text(theme.fg("error", replaceTabs(this.#roomError)), 0, 0));
			this.addChild(new Spacer(1));
		}
		this.addChild(
			new RoomPane(
				this.#roomMessages,
				this.#roomScrollOffset,
				this.#computeBodyHeight(),
				this.#roomLoading,
				start => {
					this.#roomResolvedStart = start;
				},
			),
		);
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
		} else if (this.#activeView === "live") {
			this.#buildLiveView();
		} else if (this.#activeView === "room") {
			this.#buildRoomView();
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
			// Say when this whole table has no effect, and why. The two settings that
			// decide whether anything is delegated are `subagent.delegation` and this
			// table, and an operator toggling rows here cannot see the other one — so
			// a table that will delegate nothing says so rather than implying it is
			// about to run six agents.
			const blocked = this.#delegationNotice();
			if (blocked) {
				this.addChild(new Text(theme.fg("warning", replaceTabs(blocked)), 0, 0));
				this.addChild(new Spacer(1));
			}
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
				this.#showModelBreakdown,
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
		// The lens is a layer inside Live, so Esc leaves the lens before it leaves
		// the card. Anything else would make opening an agent a one-way trip.
		if (this.#lensAgentId) {
			this.#lensAgentId = null;
			this.#buildLayout();
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
			if (this.#activeView === "room") {
				void this.#reloadRoom();
				return;
			}
			void this.#reloadData();
			return;
		}

		if (handleTabSwitchKey(data, direction => this.#switchView(direction))) {
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

		// Live and Room own their remaining keys. Falling through would let `space`
		// silently toggle an agent in the configuration list while the reader is
		// looking at a transcript.
		if (this.#activeView === "live") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				const selected = this.#liveAgents[this.#liveSelectedIndex];
				if (selected) {
					this.#lensAgentId = selected.id;
					this.#buildLayout();
				}
			}
			return;
		}
		if (this.#activeView === "room") {
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
		// Same idiom as `n`: a bare letter that acts instead of typing into the
		// search box. The footer chip is what makes it discoverable.
		if (data.toLowerCase() === "m") {
			this.#showModelBreakdown = !this.#showModelBreakdown;
			this.#buildLayout();
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

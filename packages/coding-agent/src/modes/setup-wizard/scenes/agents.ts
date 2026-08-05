import {
	routeSelectListMouse,
	type SelectItem,
	type SelectList,
	type SgrMouseEvent,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { discoverAgents } from "../../../task/discovery";
import { isSubagentEnabled } from "../../../task/subagent-settings";
import type { AgentDefinition } from "../../../task/types";
import { theme } from "../../theme/theme";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost, SetupWizardContext } from "./types";
import { createWizardList, filterEscapeHint } from "./wizard-list";

const CONTINUE_VALUE = "__continue";
const MAX_VISIBLE = 10;

export class AgentsSceneController implements SetupSceneController {
	title = "Choose subagents";
	subtitle = "Enable only the roles you want the model to start on its own.";
	#selected: Set<string>;
	#list: SelectList;
	#committing = false;
	#listRowStart = 0;
	/** Rows the wizard last offered this scene's body; see `render`. */
	#rows = MAX_VISIBLE;

	constructor(
		private readonly host: SetupSceneHost,
		private readonly agents: readonly AgentDefinition[],
	) {
		this.#selected = new Set(
			agents.filter(agent => isSubagentEnabled(host.ctx.settings, agent)).map(agent => agent.name),
		);
		this.#list = this.#buildList(0);
	}

	#buildList(selectedIndex: number): SelectList {
		// No description column. Every role's description is a full sentence that
		// cannot fit beside the name at this width: inline it arrived cut
		// ("General-purpose subagent with full capab"), and wrapping it in place
		// cost three rows per role, so four of seven roles fit on screen. The list
		// stays one row per role, so you see every role you are choosing between,
		// and `#renderDetail` prints the highlighted role's whole description
		// underneath.
		const items: SelectItem[] = this.agents.map(agent => ({
			value: agent.name,
			label: `${this.#selected.has(agent.name) ? theme.checkbox.checked : theme.checkbox.unchecked} ${agent.name}`,
		}));
		items.push({ value: CONTINUE_VALUE, label: `Continue with ${this.#selected.size} enabled` });
		const list = createWizardList(items, Math.min(this.#rows, items.length));
		list.setSelectedIndex(selectedIndex);
		list.onSelect = item => this.#activate(item.value);
		list.onCancel = () => this.host.finish("skipped");
		list.onSelectionChange = () => this.host.requestRender();
		return list;
	}

	/** The highlighted row's full description, wrapped, under the list. */
	#renderDetail(width: number, budget: number): string[] {
		if (budget <= 1) return [];
		const value = this.#list.getSelectedItem()?.value;
		const text =
			value === CONTINUE_VALUE
				? this.#selected.size === 0
					? "No subagents enabled: every task stays with the main agent."
					: `${this.#selected.size} enabled. The model may start these on its own.`
				: this.agents.find(agent => agent.name === value)?.description;
		if (!text) return [];
		const wrapped = wrapTextWithAnsi(text, Math.max(20, width - 2)).slice(0, budget - 1);
		return ["", ...wrapped.map(line => theme.fg("muted", `  ${line}`))];
	}

	#activate(value: string): void {
		if (this.#committing) return;
		if (value === CONTINUE_VALUE) {
			void this.#commit();
			return;
		}
		if (this.#selected.has(value)) this.#selected.delete(value);
		else this.#selected.add(value);
		this.#rebuild(value);
	}

	#rebuild(selectedValue: string): void {
		const index =
			selectedValue === CONTINUE_VALUE
				? this.agents.length
				: Math.max(
						0,
						this.agents.findIndex(agent => agent.name === selectedValue),
					);
		this.#list = this.#buildList(index);
		this.host.requestRender();
	}

	async #commit(): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		const current = this.host.ctx.settings.get("subagent.agents") ?? {};
		const next = { ...current };
		for (const agent of this.agents) {
			next[agent.name] = { ...next[agent.name], enabled: this.#selected.has(agent.name) };
		}
		this.host.ctx.settings.set("subagent.agents", next);
		await this.host.ctx.settings.flush();
		this.host.finish("done");
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	/**
	 * More roles than the step has rows makes this list searchable, and its Esc
	 * clears the filter. Unclaimed, that Esc left onboarding instead, discarding
	 * every checkbox the user had already set on this step.
	 */
	escapeAction(): SetupKeyHint | undefined {
		return filterEscapeHint(this.#list);
	}

	/** Space is this scene's real verb: rows are toggled, not picked once. */
	keyHints(): readonly SetupKeyHint[] {
		return [
			{ keys: "↑↓", label: "select" },
			{ keys: "space", label: "toggle" },
			{ keys: "enter", label: "confirm" },
		];
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		if (data === " ") {
			const item = this.#list.getSelectedItem();
			if (item && item.value !== CONTINUE_VALUE) {
				this.#activate(item.value);
				return;
			}
		}
		this.#list.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#committing) return;
		routeSelectListMouse(this.#list, event, line - this.#listRowStart);
	}

	render(width: number, rows?: number): readonly string[] {
		// One wrapped line, not two clipped ones. Both rows used to run past the
		// 72-column content column at an 80-column terminal ("the model may
		// star…", "Settings → Suba…"), and the first of them only repeated what
		// the subtitle and the footer's "space toggle" already say.
		const lines = [
			...wrapTextWithAnsi(
				"Disabled roles stay with the main agent. Change this later in Settings → Subagents.",
				width,
			).map(line => theme.fg("dim", line)),
			"",
		];
		this.#listRowStart = lines.length;
		// The detail block gets a fixed slice of the budget so the list does not
		// grow into it and push it off-screen; the list takes what is left.
		const detailBudget = 4;
		if (rows !== undefined) {
			this.#rows = Math.max(1, rows - lines.length - detailBudget);
			this.#list.setRowBudget(this.#rows);
		}
		lines.push(...this.#list.render(width));
		lines.push(...this.#renderDetail(width, detailBudget));
		return lines;
	}
}

/**
 * Roles carried from `shouldRun`, which `selectSetupScenes` always runs first,
 * to `mount`, which is sync.
 *
 * Keyed by the context the discovery ran for rather than held in one
 * module-level variable, which belongs to the PROCESS: one wizard run's roles
 * were still sitting there for the next run to mount on, and in a test process
 * one suite's discovery became the next suite's rows. Keying by context also
 * survives the re-mount that pressing `←` performs.
 *
 * A context with no entry has had no discovery, which is the same thing to this
 * scene as discovering nothing, and it renders that state explicitly: the only
 * row is "Continue with 0 enabled", detailed as "No subagents enabled: every
 * task stays with the main agent."
 */
const discoveredAgents = new WeakMap<SetupWizardContext, AgentDefinition[]>();

export const agentsSetupScene: SetupScene = {
	id: "subagents",
	stepLabel: "Subagents",
	title: "Choose subagents",
	minVersion: 1,
	shouldRun: async ctx => {
		const agents = (await discoverAgents(ctx.settings.getCwd())).agents.toSorted((left, right) =>
			left.name === "task" ? -1 : right.name === "task" ? 1 : left.name.localeCompare(right.name),
		);
		discoveredAgents.set(ctx, agents);
		return agents.length > 0;
	},
	mount: host => new AgentsSceneController(host, discoveredAgents.get(host.ctx) ?? []),
};

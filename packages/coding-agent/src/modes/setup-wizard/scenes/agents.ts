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

	escapeAction(): SetupKeyHint | undefined {
		return filterEscapeHint(this.#list);
	}

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
		const lines = [
			...wrapTextWithAnsi(
				"Disabled roles stay with the main agent. Change this later in Settings → Subagents.",
				width,
			).map(line => theme.fg("dim", line)),
			"",
		];
		this.#listRowStart = lines.length;
		const detailBudget = 4;
		if (rows !== undefined) {
			this.#rows = Math.max(1, rows - lines.length - detailBudget);
			this.#list.setRowBudget(this.#rows);
		}
		const ll = this.#list.render(width);
		for (let li = 0; li < ll.length; li++) lines.push(ll[li]!);
		const rd = this.#renderDetail(width, detailBudget);
		for (let li = 0; li < rd.length; li++) lines.push(rd[li]!);
		return lines;
	}
}

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

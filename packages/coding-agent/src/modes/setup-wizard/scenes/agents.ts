import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@veyyon/tui";
import { discoverAgents } from "../../../task/discovery";
import { isSubagentEnabled } from "../../../task/subagent-settings";
import type { AgentDefinition } from "../../../task/types";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const CONTINUE_VALUE = "__continue";
const MAX_VISIBLE = 10;

export class AgentsSceneController implements SetupSceneController {
	title = "Choose subagents";
	subtitle = "Enable only the roles you want the model to start on its own.";
	#selected: Set<string>;
	#list: SelectList;
	#committing = false;
	#listRowStart = 0;

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
			description: agent.description,
		}));
		items.push({
			value: CONTINUE_VALUE,
			label: `Continue with ${this.#selected.size} enabled`,
			description: this.#selected.size === 0 ? "All work stays with the main agent" : "",
		});
		const list = new SelectList(items, Math.min(MAX_VISIBLE, items.length), getSelectListTheme());
		list.setSelectedIndex(selectedIndex);
		list.onSelect = item => this.#activate(item.value);
		list.onCancel = () => this.host.finish("skipped");
		return list;
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

	render(width: number): readonly string[] {
		const lines = [
			theme.fg("muted", "Each agent is a distinct role. Space toggles which roles the model may start."),
			theme.fg("dim", "Disabled roles stay with the main agent. You can change this later in Settings → Subagents."),
			"",
		];
		this.#listRowStart = lines.length;
		lines.push(...this.#list.render(width));
		return lines;
	}
}

let discoveredAgents: AgentDefinition[] = [];

export const agentsSetupScene: SetupScene = {
	id: "subagents",
	title: "Choose subagents",
	minVersion: 1,
	shouldRun: async ctx => {
		discoveredAgents = (await discoverAgents(ctx.settings.getCwd())).agents.toSorted((left, right) =>
			left.name === "task" ? -1 : right.name === "task" ? 1 : left.name.localeCompare(right.name),
		);
		return discoveredAgents.length > 0;
	},
	mount: host => new AgentsSceneController(host, discoveredAgents),
};

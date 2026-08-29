import { routeSelectListMouse, type SelectList, type SgrMouseEvent, wrapTextWithAnsi } from "@veyyon/tui";
import { normalizeApprovalMode } from "../../../tools/approval";
import { theme } from "../../theme/theme";
import { MAX_VISIBLE, RUNG_ITEMS } from "./approvals-helpers";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost } from "./types";
import { createWizardList, filterEscapeHint } from "./wizard-list";

export class ApprovalsSceneController implements SetupSceneController {
	title = "Choose how much it does on its own";
	subtitle = "You can change this any time in Settings, or for one session with /permissions.";

	#list: SelectList;
	#listRowStart = 0;
	#status: string[] = [];

	constructor(private readonly host: SetupSceneHost) {
		const current = normalizeApprovalMode(host.ctx.settings.get("tools.approvalMode"));
		const items = RUNG_ITEMS.map(item =>
			item.value === current ? { ...item, label: `${item.label} (current)` } : item,
		);
		this.#list = createWizardList(items, MAX_VISIBLE);
		const index = items.findIndex(item => item.value === current);
		if (index >= 0) this.#list.setSelectedIndex(index);
		this.#list.onSelectionChange = () => {
			this.#status = [];
			host.requestRender();
		};
		this.#list.onSelect = item => this.#apply(item.value);
		this.#list.onCancel = () => host.finish("skipped");
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#list, event, line - this.#listRowStart);
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	escapeAction(): SetupKeyHint | undefined {
		return filterEscapeHint(this.#list);
	}

	render(width: number, rows?: number): readonly string[] {
		const intro = wrapTextWithAnsi(
			"Tools are grouped by what they touch: reading, editing files, and running commands.",
			width,
		).map(line => theme.fg("muted", line));
		const statusRows = this.#status.length > 0 ? 2 : 0;
		const roomForIntro = rows === undefined || rows - statusRows - intro.length - 1 >= 2;
		const lines = roomForIntro ? intro.concat("") : [];
		this.#listRowStart = lines.length;
		if (rows !== undefined) {
			this.#list.setRowBudget(Math.max(1, rows - lines.length - statusRows));
		}
		const ll = this.#list.render(width);
		for (let li = 0; li < ll.length; li++) lines.push(ll[li]!);
		if (this.#status.length > 0) {
			lines.push("");
			for (let si = 0; si < this.#status.length; si++) {
				const wrapped = wrapTextWithAnsi(this.#status[si]!, width);
				for (let wi = 0; wi < wrapped.length; wi++) lines.push(wrapped[wi]!);
			}
		}
		return lines;
	}

	#apply(value: string): void {
		const level = normalizeApprovalMode(value);
		this.host.ctx.settings.set("tools.approvalMode", level);
		if (normalizeApprovalMode(this.host.ctx.settings.get("tools.approvalMode")) !== level) {
			this.#status = [
				theme.fg(
					"error",
					`${theme.status.error} Could not save the tool approval setting. Set it in /settings once the config file is writable.`,
				),
			];
			this.host.requestRender();
			return;
		}
		this.host.finish("done");
	}
}

export const approvalsSetupScene: SetupScene = {
	id: "approvals",
	stepLabel: "Approvals",
	title: "Choose how much it does on its own",
	minVersion: 1,
	mount: host => new ApprovalsSceneController(host),
};

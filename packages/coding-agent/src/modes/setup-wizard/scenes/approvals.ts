import {
	routeSelectListMouse,
	type SelectItem,
	type SelectList,
	type SgrMouseEvent,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { normalizeApprovalMode } from "../../../tools/approval";
import { AUTONOMY_LABEL, type AutonomyLevel } from "../../../tools/approval-modes";
import { theme } from "../../theme/theme";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost } from "./types";
import { createWizardList, filterEscapeHint } from "./wizard-list";

const MAX_VISIBLE = 6;

/** The rungs offered during onboarding, in the order they grant rope. `plan` is deliberately absent. It is a cap plan mode applies to itself, not a */
// Each description has to fit the picker's description column, which is about 38 columns wide at every terminal size (the wizard caps its content column at
const RUNG_ITEMS: readonly SelectItem[] = (
	[
		["ask", "Asks first for every tool call"],
		["ask-command", "Asks before running a command"],
		["auto", "Runs; boundary checks still ask"],
		// NOT "not even rm -rf /". The critical floor survives this rung: a destructive command still stops and asks, which is the one guard yolo
		["yolo", "Only destructive commands ask"],
	] as const satisfies readonly (readonly [AutonomyLevel, string])[]
).map(([value, description]) => ({ value, label: AUTONOMY_LABEL[value], description }));

/** "How much can it do on its own" onboarding step. This exists because the shipped default used to be `yolo`, which meant a whole */
export class ApprovalsSceneController implements SetupSceneController {
	title = "Choose how much it does on its own";
	subtitle = "You can change this any time in Settings, or for one session with /permissions.";

	#list: SelectList;
	#listRowStart = 0;
	#status: string[] = [];

	constructor(private readonly host: SetupSceneHost) {
		// Seeded from the current effective value rather than from a hardcoded row, so `veyyon setup` re-run by someone who already chose `yolo` opens
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

	/** Four rungs in six rows never overflow, so this list is not searchable today and this returns nothing. Wired for the same reason as the glyph step: the */
	escapeAction(): SetupKeyHint | undefined {
		return filterEscapeHint(this.#list);
	}

	render(width: number, rows?: number): readonly string[] {
		// Wrapped, not one long row: at 80 columns the wizard's content column is
		// 72 and this sentence is 83, so it used to end "and running c…" with the
		// only ellipsis on screen.
		const intro = wrapTextWithAnsi(
			"Tools are grouped by what they touch: reading, editing files, and running commands.",
			width,
		).map(line => theme.fg("muted", line));
		const statusRows = this.#status.length > 0 ? 2 : 0;
		// THE PROSE GOES BEFORE THE RUNGS DO. On a 20-row terminal the wizard's chrome leaves about three body rows, and the intro plus its spacer is
		const roomForIntro = rows === undefined || rows - statusRows - intro.length - 1 >= 2;
		const lines = roomForIntro ? intro.concat("") : [];
		this.#listRowStart = lines.length;
		// Size the list to the rows the wizard actually has, the way every other list scene does. Without it the list always emitted all four rungs and
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

	/** Commit the chosen rung. The write is READ BACK before the step is called done. `Settings.set` is */
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

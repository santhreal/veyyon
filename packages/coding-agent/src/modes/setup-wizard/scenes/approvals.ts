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

/**
 * The rungs offered during onboarding, in the order they grant rope.
 *
 * `plan` is deliberately absent. It is a cap plan mode applies to itself, not a
 * standing preference, and offering it here would let someone onboard into a
 * session that cannot run a command and has no idea why. It stays reachable
 * from `/settings` and `/permissions`.
 */
// Each description has to fit the picker's description column, which is about
// 38 columns wide at every terminal size (the wizard caps its content column at
// 76). The sentences here were 60 to 90 columns, so every row arrived as a
// fragment ("Every tool call asks first, reads in") on wide terminals too.
// `SelectList` now marks a cut with an ellipsis, which makes the loss visible
// rather than affordable: the column has not grown. Which rung is in force is
// marked on the row itself; see the constructor.
const RUNG_ITEMS: readonly SelectItem[] = (
	[
		["ask", "Asks first for every tool call"],
		["ask-command", "Asks before running a command"],
		["auto", "Runs; boundary checks still ask"],
		// NOT "not even rm -rf /". The critical floor survives this rung: a
		// destructive command still stops and asks, which is the one guard yolo
		// keeps. Overstating the danger here is not a harmless scare, it is the
		// sentence a first-time user reads to decide, and every other surface
		// describing this rung says the true thing.
		["yolo", "Only destructive commands ask"],
	] as const satisfies readonly (readonly [AutonomyLevel, string])[]
).map(([value, description]) => ({ value, label: AUTONOMY_LABEL[value], description }));

/**
 * "How much can it do on its own" onboarding step.
 *
 * This exists because the shipped default used to be `yolo`, which meant a whole
 * approval ladder that never once fired: the prompts, the per-tool policies and
 * the filesystem and credential boundaries were all reachable only by an
 * operator who already knew to go looking for a setting. Asking here makes the
 * choice deliberate in the one place a new user is already making choices, and
 * the status line then keeps naming the answer for the rest of the session.
 *
 * What it writes is the PERSISTED default. A session that needs a different
 * answer says so with `/permissions`, which overrides without touching this.
 */
export class ApprovalsSceneController implements SetupSceneController {
	title = "Choose how much it does on its own";
	subtitle = "You can change this any time in Settings, or for one session with /permissions.";

	#list: SelectList;
	#listRowStart = 0;
	#status: string[] = [];

	constructor(private readonly host: SetupSceneHost) {
		// Seeded from the current effective value rather than from a hardcoded
		// row, so `veyyon setup` re-run by someone who already chose `yolo` opens
		// on `yolo` instead of silently proposing to downgrade them. That row also
		// says "(current)": the cursor alone does not tell a first-time user that
		// pressing Enter right now KEEPS what is already in force rather than
		// picking something new.
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

	/**
	 * Four rungs in six rows never overflow, so this list is not searchable today
	 * and this returns nothing. Wired for the same reason as the glyph step: the
	 * scene answers Esc the same way every other list-owning scene does, so a
	 * fifth rung cannot silently turn Esc back into "end the run".
	 */
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
		// THE PROSE GOES BEFORE THE RUNGS DO. On a 20-row terminal the wizard's
		// chrome leaves about three body rows, and the intro plus its spacer is
		// exactly that, so keeping it pushed every rung off the step: the operator
		// read an explanation of a choice they could not see or make. The
		// explanation is worth having and the choice is the step, so the intro is
		// what yields. Two list rows is the floor worth keeping it above: one
		// item plus the search row is not a list you can compare answers in.
		const roomForIntro = rows === undefined || rows - statusRows - intro.length - 1 >= 2;
		const lines = roomForIntro ? [...intro, ""] : [];
		this.#listRowStart = lines.length;
		// Size the list to the rows the wizard actually has, the way every other
		// list scene does. Without it the list always emitted all four rungs and
		// the overlay clipped the tail, so `Auto` and `Yolo` were off screen and
		// stayed off screen however far you arrowed down: Enter then committed a
		// rung the operator could not see.
		if (rows !== undefined) {
			this.#list.setRowBudget(Math.max(1, rows - lines.length - statusRows));
		}
		lines.push(...this.#list.render(width));
		if (this.#status.length > 0) {
			lines.push("", ...this.#status.flatMap(line => wrapTextWithAnsi(line, width)));
		}
		return lines;
	}

	/**
	 * Commit the chosen rung.
	 *
	 * The write is READ BACK before the step is called done. `Settings.set` is
	 * deliberately non-throwing, so a config file the filesystem refuses used to
	 * advance the wizard having changed nothing, and the operator was told the
	 * rung was set when it was not. `markSetupWizardComplete` reads its own write
	 * back for the same reason; this is that rule applied to the one other write
	 * the wizard makes.
	 *
	 * There is no success line. The scene finishes immediately, which unmounts
	 * it, so a status set here rendered only inside the cross-dissolve and not at
	 * all when approvals is the last step. The next screen is the confirmation.
	 */
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

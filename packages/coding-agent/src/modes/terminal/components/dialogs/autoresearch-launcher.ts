/**
 * The autoswarm launcher: what `/autoswarm` opens on a branch with no
 * session. One centered card, one form, one button. The goal is typed, the
 * shape is picked or stepped, Enter starts the swarm, and the card closes so
 * the first turn can run under it.
 *
 * Over a session the same form is one key away in the dashboard
 * ({@link ./autoresearch-screen}); this card exists so that the first start is not a
 * ledger with nothing in it.
 */
import type { Component, OverlayOptions } from "@veyyon/tui";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ConsoleAction, LoopConsoleModel } from "../../../../autoresearch/console";
import { theme } from "../../../../theme/theme";
import { bottomBorder, divider, row, topBorder, topBorderTitleWidth } from "../chrome/overlay-box";
import { footerHint } from "./autoresearch-screen";
import { SetupFormComponent } from "./autoresearch-setup-form";

/** The card's width: enough for a label column, a goal and the notes, never the whole terminal. */
export const LAUNCHER_WIDTH = 72;

/** Where the card sits: centered, a row clear of every edge, above the composer. */
export const LAUNCHER_OVERLAY: OverlayOptions = {
	anchor: "center",
	width: LAUNCHER_WIDTH,
	maxHeight: "100%",
	margin: 1,
	aboveFooter: true,
};

/** Chrome rows: the title border, the divider, the footer and the bottom border. */
const CHROME_ROWS = 4;

export class LauncherComponent implements Component, MouseRoutable {
	readonly #form: SetupFormComponent;
	readonly #close: () => void;
	readonly #rows: () => number;
	/** Rows the body took in the last paint, so a report is matched to the form. */
	#bodyRows = 0;

	constructor(options: {
		model: LoopConsoleModel;
		close: () => void;
		requestRender: () => void;
		/** Rows the overlay can paint. */
		rows: () => number;
	}) {
		this.#close = options.close;
		this.#rows = options.rows;
		const model = options.model;
		this.#form = new SetupFormComponent({
			model,
			onAction: (action: ConsoleAction) => {
				if (model.perform(action) === "close") this.#close();
				else options.requestRender();
			},
			onCancel: () => this.#close(),
		});
		this.#form.focus(model.goal.trim().length === 0 ? "goal" : "action");
	}

	invalidate(): void {}

	/** Put the ring on `id`, for a host that opens the card on a field. */
	focus(id: string): void {
		this.#form.focus(id);
	}

	render(width: number): readonly string[] {
		const inner = Math.max(1, width - 4);
		const budget = Math.max(1, this.#rows() - CHROME_ROWS);
		const body = this.#form.render(inner, budget);
		this.#bodyRows = body.length;
		const out: string[] = [topBorder(width, truncateToWidth("Autoswarm", topBorderTitleWidth(width)), theme)];
		for (const line of body) out.push(row(line, width, theme));
		out.push(divider(width, theme));
		out.push(row(theme.fg("dim", footerHint(width, [this.#form.hint(), "↑↓ field"])), width, theme));
		out.push(bottomBorder(width, theme));
		return out.map(line => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		this.#form.handleInput(data);
	}

	/** A report in the card's cells: the body starts under the title, inset by the border and a space. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const bodyLine = line - 1;
		if (bodyLine < 0 || bodyLine >= this.#bodyRows) return;
		this.#form.routeMouse(event, bodyLine, Math.max(0, col - 2));
	}
}

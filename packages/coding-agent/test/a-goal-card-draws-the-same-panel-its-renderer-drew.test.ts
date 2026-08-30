/**
 * The goal tool describes its card as data, and the terminal draws the panel its renderer drew.
 *
 * WHY THIS SUITE EXISTS. `goals/goal-tool.ts` held a `framedBlock` closure over a width the terminal
 * handed it, which is the tightest form of the coupling this migration exists to remove: the tool did
 * not merely name a colour, it laid itself out against the terminal's geometry. It now returns a
 * `FramedBlockView` and names no width, no colour, no glyph and no component. That is only true if
 * the panel on screen is unchanged, so this compares the drawn rows against the expressions the
 * renderer held before, reproduced here.
 *
 * THE DEFECT CLASS THIS CLOSES. Five ways converting a framed renderer silently changes the screen:
 *
 *  - The FRAME changes. A block reads its state and its rail colour from what it was told; a view
 *    states a status and the host reduces it. A reduction that picks the wrong state repaints the
 *    card's whole ground, so the rows are compared against the old options at the same width.
 *  - A LINE loses its styling. Sections used to arrive as pre-coloured strings and now arrive as
 *    spans, so a span whose tone was dropped renders as plain text that still reads correctly at a
 *    glance. Every row is compared byte for byte where the composition is unchanged.
 *  - The HEADER loses the tool's own mark. A settled goal card is titled `◎ Goal`, not `✔ Goal`; the
 *    emblem is the member that carries that, and a host with no entry for the key has to fall back to
 *    the status icon rather than draw a blank column.
 *  - The OPERATION stops being named. A failed call carries no details, so the header's description
 *    comes from the call arguments. Dropping that parameter turns `resume` into `?`.
 *  - The CARD disappears from a rebuilt transcript. A view-only tool has no `renderCall`, so the
 *    terminal's registry entry is what draws a session that never constructed the tool. It is
 *    compared against the view directly.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Two rows change bytes on purpose and are asserted as an
 * equivalence rather than an identity. `theme.italic(theme.fg("muted", text))` was the old order and
 * a span emits `theme.fg("muted", theme.italic(text))`: the same two attributes nested the other way,
 * which every terminal that honours SGR renders identically and which this suite pins as visible text
 * plus both attributes present. It also says nothing about pixels, and nothing about the goal tool's
 * `execute`, which `goal-tool.test.ts` covers.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { GoalTool, goalToolView } from "@veyyon/coding-agent/goals/goal-tool";
import type { Goal, GoalToolDetails } from "@veyyon/coding-agent/goals/state";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/render-utils";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { drawStatusRow, drawToolView, toolDrawsItself } from "@veyyon/coding-agent/tui/draw-tool-view";
import { framedBlock } from "@veyyon/coding-agent/tui/output-block";
import { renderStatusLine } from "@veyyon/coding-agent/tui/status-line";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";

/**
 * Colour is forced on, through its one owner and restored after.
 *
 * Under the policy a piped run detects, `fg` and `italic` are both the identity, so every byte
 * comparison below would pass on strings with no styling in them at all.
 */
let entryPolicy: AnsiPolicy;

beforeAll(async () => {
	await initTheme();
	entryPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(entryPolicy);
});

const COLLAPSED = { expanded: false } as const;

/** The width the panel is compared at. Any width works; the point is that both sides get the same one. */
const WIDTH = 80;

function goal(overrides?: Partial<Goal>): Goal {
	return {
		objective: "Ship the plugin host",
		status: "active",
		tokensUsed: 12_000,
		timeUsedSeconds: 0,
		...overrides,
	} as Goal;
}

function result(
	details: GoalToolDetails,
	text = "Goal: ok",
): {
	content: Array<{ type: string; text?: string }>;
	details?: GoalToolDetails;
	isError?: boolean;
} {
	return { content: [{ type: "text", text }], details };
}

function rows(view: ReturnType<typeof goalToolView.renderResult>): readonly string[] {
	return drawToolView(view, theme).render(WIDTH);
}

/**
 * A one-line view as the terminal emits it, minus the trailing pad.
 *
 * `Text.render` pads a row to the width it was given, which the old renderers' bare strings did not
 * carry, so the pad is dropped on both sides rather than written into every expectation.
 */
function line(view: ReturnType<typeof goalToolView.renderCall>): string {
	return drawToolView(view, theme).render(WIDTH).join("\n").trimEnd();
}

/** Visible text with every escape sequence removed, which is what a reader sees. */
function visible(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line));
}

describe("a goal card draws the same panel its renderer drew", () => {
	it("draws the pending call row the status line drew, with the objective still muted and italic", () => {
		const objective = "Ship the plugin host end to end";
		const view = goalToolView.renderCall({ op: "create", objective }, COLLAPSED);
		const drawn = line(view);

		const before = renderStatusLine(
			{
				icon: "pending",
				title: "Goal",
				description: "set",
				meta: [theme.italic(theme.fg("muted", `"${truncateToWidth(objective, TRUNCATE_LENGTHS.TITLE)}"`))],
			},
			theme,
		);

		expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(before).trimEnd());
		// Both attributes survive, nested the other way, which is the whole difference.
		expect(drawn).toBe(
			renderStatusLine(
				{
					icon: "pending",
					title: "Goal",
					description: "set",
					meta: [theme.fg("muted", theme.italic(`"${truncateToWidth(objective, TRUNCATE_LENGTHS.TITLE)}"`))],
				},
				theme,
			).trimEnd(),
		);
	});

	it("names the operation and nothing else when the call carries no objective", () => {
		const view = goalToolView.renderCall({ op: "get" }, COLLAPSED);

		expect(line(view)).toBe(
			renderStatusLine({ icon: "pending", title: "Goal", description: "check", meta: [] }, theme).trimEnd(),
		);
	});

	it("draws the same row for a result with no goal in it", () => {
		const view = goalToolView.renderResult(
			{
				content: [{ type: "text", text: "No active goal." }],
				details: { op: "get", goal: null } as GoalToolDetails,
			},
			COLLAPSED,
		);
		expect(line(view)).toBe(
			renderStatusLine(
				{ icon: "warning", title: "Goal", description: "check", meta: ["no active goal"] },
				theme,
			).trimEnd(),
		);
	});

	it("draws the error panel the framed block drew, rail and indent included", () => {
		const view = goalToolView.renderResult(
			{ content: [{ type: "text", text: "Goal mode is not active." }], isError: true },
			COLLAPSED,
			{ op: "resume" },
		);

		const before = framedBlock(theme, width => ({
			header: renderStatusLine({ icon: "error", title: "Goal", description: "resume" }, theme),
			sections: [{ lines: [`  ${theme.fg("error", "Goal mode is not active.")}`] }],
			state: "error",
			borderColor: "error",
			width,
		})).render(WIDTH);

		expect(rows(view)).toEqual(before);
	});

	it("reports the operation from the call arguments when the failure carries no details", () => {
		for (const op of ["create", "get", "complete", "resume", "drop"] as const) {
			const view = goalToolView.renderResult({ content: [], isError: true }, COLLAPSED, { op });
			const header = visible(rows(view))[0] ?? "";

			expect(header).toContain(op === "create" ? "set" : op === "get" ? "check" : op);
		}
		// And without arguments it says so rather than inventing an operation.
		const blind = goalToolView.renderResult({ content: [], isError: true }, COLLAPSED);
		expect(visible(rows(blind))[0]).toContain("?");
	});

	it("draws the settled panel the framed block drew, under the goal's own emblem", () => {
		const active = goal({ tokenBudget: 40_000, timeUsedSeconds: 0 });
		const view = goalToolView.renderResult(result({ op: "get", goal: active } as GoalToolDetails), COLLAPSED);

		const before = framedBlock(theme, width => ({
			header: renderStatusLine(
				{
					iconOverride: theme.styledSymbol("tool.goal", "accent"),
					title: "Goal",
					description: "check",
					badge: { label: "active", color: "accent" },
				},
				theme,
			),
			sections: [
				{
					lines: [
						theme.italic(theme.fg("muted", `"${active.objective}"`)),
						theme.fg(
							"dim",
							`${formatNumber(12_000)} / ${formatNumber(40_000)} tokens (${formatNumber(28_000)} left)`,
						),
					],
				},
			],
			state: "success",
			borderColor: "borderMuted",
			width,
		})).render(WIDTH);

		const drawn = rows(view);
		// The frame, the widths and every visible character are identical.
		expect(visible(drawn)).toEqual(visible(before));
		// The header and the token line are byte-identical; only the objective line re-nests its two
		// attributes, so it is compared as an equivalence.
		expect(drawn[0]).toBe(before[0]);
		expect(drawn[2]).toBe(before[2]);
		expect(drawn[1]).toContain("\x1b[3m");
		expect(drawn[1]).not.toBe(before[1]);
		expect(drawn.length).toBe(before.length);
	});

	it("keeps the completion report as its own labelled section", () => {
		const completed = goal({ status: "complete", timeUsedSeconds: 90 });
		const view = goalToolView.renderResult(
			result({
				op: "complete",
				goal: completed,
				completionBudgetReport: "spent 12,000\nof 40,000",
			} as GoalToolDetails),
			COLLAPSED,
		);

		const drawn = visible(rows(view));

		expect(drawn.some(line => line.includes("Report"))).toBe(true);
		expect(drawn.some(line => line.includes("spent 12,000"))).toBe(true);
		expect(drawn.some(line => line.includes("of 40,000"))).toBe(true);
		// Every line of a multi-line report carries the tone, which the pre-coloured string form
		// could not do: it opened the colour once and left the continuation lines bare.
		for (const row of rows(view)) {
			if (stripVTControlCharacters(row).includes("of 40,000")) expect(row).toContain("\x1b[");
		}
	});

	it("tones the badge by what the status means", () => {
		const tones: Array<[Goal["status"], ThemeColor]> = [
			["complete", "success"],
			["budget-limited", "warning"],
			["paused", "muted"],
			["dropped", "muted"],
			["active", "accent"],
		];
		for (const [status, color] of tones) {
			const view = goalToolView.renderResult(
				result({ op: "get", goal: goal({ status }) } as GoalToolDetails),
				COLLAPSED,
			);
			const header = rows(view)[0] ?? "";

			expect(header).toBe(
				framedBlock(theme, width => ({
					header: renderStatusLine(
						{
							iconOverride: theme.styledSymbol("tool.goal", "accent"),
							title: "Goal",
							description: "check",
							badge: { label: status, color },
						},
						theme,
					),
					sections: [],
					state: "success",
					borderColor: "borderMuted",
					width,
				})).render(WIDTH)[0],
			);
		}
	});

	it("falls back to the status icon when the host has no glyph for the emblem", () => {
		const known = drawStatusRow({ kind: "statusRow", emblem: "tool.goal", status: "warning", title: "Goal" }, theme);
		const unknown = drawStatusRow(
			{ kind: "statusRow", emblem: "tool.a-host-has-never-heard-of-this", status: "warning", title: "Goal" },
			theme,
		);

		expect(unknown).toBe(drawStatusRow({ kind: "statusRow", status: "warning", title: "Goal" }, theme));
		expect(known).not.toBe(unknown);
		expect(known).toContain(theme.styledSymbol("tool.goal", "accent"));
	});

	it("draws the same card through the terminal's registry as through the tool", () => {
		const entry = toolRenderers.goal;
		const payload = result({ op: "get", goal: goal() } as GoalToolDetails);
		const options = { expanded: false, isPartial: false };

		expect(entry?.mergeCallAndResult).toBe(true);
		expect(entry?.renderResult(payload, options, theme).render(WIDTH)).toEqual(
			rows(goalToolView.renderResult(payload, COLLAPSED)),
		);
		expect(entry?.renderCall({ op: "get" }, options, theme).render(WIDTH)).toEqual(
			drawToolView(goalToolView.renderCall({ op: "get" }, COLLAPSED), theme).render(WIDTH),
		);
	});

	it("carries its view on the live tool, so a host reads the card off the tool", () => {
		const tool = new GoalTool({} as ToolSession);

		expect(tool.view).toBe(goalToolView);
		expect(tool.mergeCallAndResult).toBe(true);
		expect(toolDrawsItself(tool)).toBe(true);
	});
});

/**
 * Every surface that shows a goal objective shows it as text, whatever bytes the objective holds.
 *
 * WHY THIS SUITE EXISTS. The objective is the one free-text field goal mode carries, and neither end
 * of it is this codebase's: an operator types it into `/goal`, and the goal tool takes it from the
 * model's own arguments. It then reaches four single-line surfaces -- the `/goal show` report, the
 * `/goal` menu title, the warning a disabled Goal Mode prints over a stored goal, and the `/goal`
 * autocomplete row -- plus the goal tool's own card. Each of those was formatted with the raw string.
 * An escape sequence in it styles or moves the rest of the surface, a tab opens a hole the renderer
 * measured as one column, and a newline puts half an objective where the next field's name belongs.
 *
 * THE DEFECT CLASS THIS CLOSES. A surface that formats the objective without reducing it to one
 * plain line. The suite drives each entry point `/goal` has, reading the subcommand list out of the
 * controller rather than restating it, captures every string the controller hands its host to
 * DISPLAY, and asserts none of them carries a byte a terminal acts on. A new subcommand, or a new
 * message on an existing one that interpolates the objective raw, fails here without anyone
 * remembering to add a cell.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Width: a sanitized objective is as long as it was, and truncation
 * is `truncateToWidth`'s subject, pinned per surface by its own cap. It also excludes the two
 * channels that carry the objective raw ON PURPOSE, and asserts that they still do: the text
 * submitted to the model, which is the operator's input verbatim, and the session-log record, which
 * is data rather than a drawing. Sanitizing either would change what the model reads or corrupt a
 * resumed goal.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@veyyon/catalog/models";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { goalToolView } from "@veyyon/coding-agent/goals/goal-tool";
import type { Goal, GoalModeState, GoalToolDetails } from "@veyyon/coding-agent/goals/state";
import {
	GOAL_SUBCOMMANDS,
	GoalModeController,
	type GoalModeControllerContext,
	type GoalModeHost,
} from "@veyyon/coding-agent/modes/terminal/controllers/goal-mode-controller";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { ToolView, ViewSpan } from "@veyyon/view";

/**
 * One objective carrying every class of byte that means something to a terminal: a colour sequence,
 * a cursor move, an 8-bit CSI, a tab, a newline, a carriage return, a bare C0 and a bare C1.
 */
const HOSTILE_OBJECTIVE = "Ship\u001b[31m the\u001b[2A plugin\u009b2A host\tend\nto\rend\u0001with\u0085proof";

/** The same objective as words: what every display surface must show. */
const PLAIN_OBJECTIVE = "Ship the plugin host end to end with proof";

/**
 * A byte a terminal acts on rather than draws. `\n` is absent on purpose: a report is several
 * fields, one per line, so a newline BETWEEN fields is the layout. A newline inside a field is
 * caught by the field count each surface asserts, and by the plain form above.
 */
const ACTS_ON_TERMINAL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function offendingByte(text: string): string | undefined {
	const found = ACTS_ON_TERMINAL.exec(text);
	if (!found) return undefined;
	return `U+${found[0].charCodeAt(0).toString(16).padStart(4, "0")} in ${JSON.stringify(text)}`;
}

function expectPlain(strings: readonly string[], where: string): void {
	for (const text of strings) {
		expect(offendingByte(text), `${where} draws a control byte`).toBeUndefined();
	}
}

function goal(overrides?: Partial<Goal>): Goal {
	return {
		id: "goal-1",
		objective: HOSTILE_OBJECTIVE,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		turnsCompleted: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

const IDLE_HOST: GoalModeHost = {
	isAutoSubmitBlocked: () => false,
	hasPendingSubmission: () => false,
	hasPendingVisibleUserSubmission: () => false,
	isPlanModeActive: () => false,
	withProgress: async (_label, work) => await work(),
};

interface Capture {
	/** Every string the controller handed the host to put on screen. */
	displayed: string[];
	/** Text submitted on the goal's behalf, which is the operator's own input and stays raw. */
	submitted: string[];
	/** Session-log payloads, which are records rather than drawings and stay raw. */
	logged: unknown[];
}

/**
 * The controller against a session that records instead of drawing, with a goal already stored.
 *
 * Every host member that shows text records into one list, so a message added to any path lands in
 * the sweep whether or not this file knew about it. The selector and the confirm answer "no" and the
 * editor answers nothing, which is the reader dismissing the surface after seeing it: the title has
 * already been captured by then, and the flow stops rather than needing a runtime to advance.
 */
function controllerFor(
	state: GoalModeState | undefined,
	goalEnabled = true,
): { controller: GoalModeController; capture: Capture } {
	const capture: Capture = { displayed: [], submitted: [], logged: [] };
	let current = state;
	const session = {
		settings: Settings.isolated({ "goal.enabled": goalEnabled, "goal.modelBudgetsEnabled": false }),
		model: getBundledModel("anthropic", "claude-sonnet-4-5"),
		isStreaming: false,
		getGoalModeState: () => current,
		setGoalModeState: (next: GoalModeState | undefined) => {
			current = next;
		},
		getActiveToolNames: () => ["read"],
		setActiveToolsByName: async () => {},
		sendGoalModeContext: async () => {},
		goalRuntime: {
			clearAccounting: () => {},
			createGoal: async ({ objective }: { objective: string }) => ({
				enabled: true,
				mode: "active" as const,
				goal: goal({ objective }),
			}),
			replaceGoal: async ({ objective }: { objective: string }) => ({
				enabled: true,
				mode: "active" as const,
				goal: goal({ objective }),
			}),
			resumeGoal: async () => ({ enabled: true, mode: "active" as const, goal: goal() }),
			pauseGoal: async () => {},
			dropGoal: async () => {},
		},
	} as unknown as GoalModeControllerContext["session"];

	const record = (message: string): void => {
		capture.displayed.push(message);
	};
	const context = {
		editor: { setText: () => {} },
		loopModeEnabled: false,
		onInputCallback: () => {},
		session,
		sessionManager: {
			appendModeChange: () => {},
			appendCustomEntry: (_kind: string, payload: unknown) => {
				capture.logged.push(payload);
			},
		},
		showError: record,
		showWarning: record,
		showStatus: record,
		showHookConfirm: async (title: string, body: string) => {
			record(title);
			record(body);
			return false;
		},
		showHookEditor: async (title: string, initial?: string) => {
			record(title);
			if (initial !== undefined) record(initial);
			return undefined;
		},
		showHookSelector: async (title: string, items: readonly string[]) => {
			record(title);
			for (const item of items) record(item);
			return undefined;
		},
		startPendingSubmission: ({ text }: { text: string }) => {
			capture.submitted.push(text);
			return text;
		},
		statusLine: { setGoalModeStatus: () => {} },
		ui: { requestRender: () => {} },
		vibeModeEnabled: false,
	} as unknown as GoalModeControllerContext;

	const controller = new GoalModeController(context, IDLE_HOST);
	controller.enabled = state?.enabled === true;
	controller.paused = state?.goal.status === "paused" && state.enabled === false;
	return { controller, capture };
}

/** Every text run a view carries, whichever kind it is, so a new kind cannot hide a raw string. */
function textOf(view: ToolView): string[] {
	const spans = (list: readonly ViewSpan[] | undefined): string[] => (list ?? []).map(span => span.text);
	switch (view.kind) {
		case "statusRow":
			return [view.title, view.description ?? "", view.badge?.label ?? "", ...spans(view.meta)];
		case "textBlock":
			return spans(view.spans);
		case "headedBlock":
			return [...(view.header === undefined ? [] : textOf(view.header)), ...view.lines.flatMap(line => spans(line))];
		case "framedBlock":
			return [
				...textOf(view.header),
				...view.sections.flatMap(section => [section.label ?? "", ...section.lines.flatMap(line => spans(line))]),
			];
		case "notice":
			return [...spans(view.headline), view.tag ?? "", ...(view.body ?? []).flatMap(line => spans(line))];
	}
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

describe("a goal objective reaches the screen as plain text", () => {
	/**
	 * The sweep. Each state a goal can be in when a command arrives, against every word `/goal`
	 * takes plus the bare invocation that opens the menu.
	 */
	const STATES: ReadonlyArray<{ what: string; state: GoalModeState | undefined }> = [
		{ what: "an active goal", state: { enabled: true, mode: "active", goal: goal() } },
		{ what: "a paused goal", state: { enabled: false, mode: "active", goal: goal({ status: "paused" }) } },
		{ what: "a completed goal", state: { enabled: false, mode: "active", goal: goal({ status: "complete" }) } },
		{ what: "no goal", state: undefined },
	];

	const ENTRIES = ["", ...Object.keys(GOAL_SUBCOMMANDS), `set ${HOSTILE_OBJECTIVE}`, HOSTILE_OBJECTIVE];

	for (const { what, state } of STATES) {
		for (const entry of ENTRIES) {
			const name = entry === "" ? "bare /goal" : `/goal ${entry.replace(HOSTILE_OBJECTIVE, "<hostile>")}`;
			it(`shows nothing a terminal acts on for ${name} with ${what}`, async () => {
				const { controller, capture } = controllerFor(state && { ...state, goal: { ...state.goal } });
				await controller.handleCommand(entry === "" ? undefined : entry);
				expectPlain(capture.displayed, name);
			});
		}
	}

	/**
	 * The sweep above passes on an empty capture, and a harness that threw before drawing anything
	 * would look exactly like a clean surface. So every state that HAS a goal is asserted to reach a
	 * surface that quotes it: without this, a broken fake reads as proof.
	 */
	it("reaches a surface that quotes the objective for every state that has one", async () => {
		for (const { what, state } of STATES) {
			if (!state) continue;
			const seen: string[] = [];
			for (const entry of [undefined, "show"] as const) {
				const { controller, capture } = controllerFor({ ...state, goal: { ...state.goal } });
				await controller.handleCommand(entry);
				seen.push(...capture.displayed);
			}
			expect(seen.join("\n"), `${what} never reached a surface quoting the objective`).toContain(PLAIN_OBJECTIVE);
		}
	});

	/** The report and the menu title are the two surfaces that quote the objective back. */
	it("reads the objective back as its words in the report", async () => {
		const { controller, capture } = controllerFor({ enabled: true, mode: "active", goal: goal() });
		await controller.handleCommand("show");
		const report = capture.displayed.join("\n");
		expect(report).toContain(`Objective: ${PLAIN_OBJECTIVE}`);
	});

	it("reads the objective back as its words in the menu title", async () => {
		const { controller, capture } = controllerFor({ enabled: true, mode: "active", goal: goal() });
		await controller.handleCommand(undefined);

		expect(capture.displayed[0]).toContain(PLAIN_OBJECTIVE);
	});

	/**
	 * Goal Mode off with a stored goal: the one warning that quotes an objective the operator never
	 * sees in a report, because the goal never activates.
	 */
	it("shows nothing a terminal acts on when a disabled Goal Mode reports a stored goal", async () => {
		const { controller, capture } = controllerFor(undefined, false);
		const outcome = await controller.restoreFromSession({ mode: "goal", modeData: { goal: goal() } } as never);

		expect(outcome).toBe("handled");
		// The warning names the goal rather than only the setting, which is why it quotes it.
		expect(capture.displayed.join("\n")).toContain("Ship the plugin host");
		expectPlain(capture.displayed, "the stored-goal warning");
	});

	/**
	 * The submitted text and the log record are the two raw channels, and they stay raw: the model
	 * reads the objective the operator wrote, and a resumed session restores the record it stored.
	 */
	it("submits the objective to the model exactly as it was written", async () => {
		const { controller, capture } = controllerFor(undefined);
		await controller.handleCommand(`set ${HOSTILE_OBJECTIVE}`);
		expect(capture.submitted).toEqual([HOSTILE_OBJECTIVE]);
	});

	/**
	 * The goal tool's card. Both renderer members are swept from the object, so a third member is a
	 * failure here rather than an uncovered surface.
	 */
	describe("the goal tool's card", () => {
		const COLLAPSED = { expanded: false } as const;

		const RENDERED: Record<string, () => ToolView> = {
			renderCall: () => goalToolView.renderCall({ op: "create", objective: HOSTILE_OBJECTIVE }, COLLAPSED),
			renderResult: () =>
				goalToolView.renderResult(
					{
						content: [{ type: "text", text: "Goal: ok" }],
						details: { op: "create", goal: goal() } as GoalToolDetails,
					},
					COLLAPSED,
				),
		};

		it("covers every member the renderer exposes", () => {
			expect(Object.keys(RENDERED).sort()).toEqual(Object.keys(goalToolView).sort());
		});

		for (const [member, render] of Object.entries(RENDERED)) {
			it(`draws no control byte from ${member}`, () => {
				const text = textOf(render());
				expectPlain(text, `goalToolView.${member}`);
				expect(text.some(run => run.includes(PLAIN_OBJECTIVE))).toBe(true);
			});
		}
	});

	/** The autocomplete row, which renders on a keystroke while the objective is still being typed. */
	it("draws no control byte in the /goal autocomplete row", () => {
		const command = BUILTIN_SLASH_COMMAND_DEFS.find(candidate => candidate.name === "goal");
		expect(command?.getTuiAutocompleteDescription).toBeDefined();
		const description = command?.getTuiAutocompleteDescription?.({
			ctx: {
				settings: Settings.isolated({ "goal.enabled": true }),
				planModeEnabled: false,
				session: { getGoalModeState: () => ({ enabled: true, mode: "active", goal: goal() }) },
			},
		} as never);
		expectPlain([description ?? ""], "the /goal autocomplete row");
		expect(description).toContain("Ship the plugin host");
	});
});

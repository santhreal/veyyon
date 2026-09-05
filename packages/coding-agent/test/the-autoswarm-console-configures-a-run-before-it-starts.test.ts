/**
 * WHY: the console model and the setup form around it govern how a loop is
 * configured before it starts or while it runs. Every rule the operator
 * relies on is pressed here against the production form: numeric clamping of
 * breadth and attempts, the keys that flip certification, digit and step
 * editing of the iteration cap, start blockers that keep an empty goal or an
 * unresolvable model from starting, the action matrix across loop states,
 * and the form listing every setup field.
 *
 * The class this closes is invalid run configuration, arrow bounds overflow,
 * a start that goes through on a missing goal or an unknown model, a
 * corrupted action matrix, and a setup field the form forgot.
 *
 * What it does not catch: theme colours or the card's frame layout, which
 * the renderer and theme suites check.
 */
import { describe, expect, it } from "bun:test";
import {
	ACTION_FIELD,
	actionsFor,
	type ConsoleAction,
	type ConsoleFieldId,
	type ConsoleSituation,
	FIELD_LABELS,
} from "@veyyon/coding-agent/autoresearch/console";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_SWARM_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { driveConsole, NO_SESSION, recordingHost } from "./helpers/autoswarm-console";
import { useTruecolorTheme } from "./helpers/theme-assertions";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const BACKSPACE = "\x7f";

const WITH_SESSION: ConsoleSituation = {
	...NO_SESSION,
	session: { name: "bench", branch: "autoresearch/bench", runs: 3 },
	harness: true,
};

describe("the autoswarm console configures a run before it starts", () => {
	useTruecolorTheme("dark");

	it("clamps breadth to MIN_SWARM_BREADTH..MAX_BREADTH and attempts to MIN_ATTEMPTS..MAX_ATTEMPTS via arrows", () => {
		const { model, press } = driveConsole({ breadth: 3, attempts: 2 });

		for (let i = 0; i < 10; i++) press("breadth", LEFT);
		expect(model.breadth).toBe(MIN_SWARM_BREADTH);
		for (let i = 0; i < 20; i++) press("breadth", RIGHT);
		expect(model.breadth).toBe(MAX_BREADTH);

		for (let i = 0; i < 15; i++) press("attempts", LEFT);
		expect(model.attempts).toBe(MIN_ATTEMPTS);
		for (let i = 0; i < 25; i++) press("attempts", RIGHT);
		expect(model.attempts).toBe(MAX_ATTEMPTS);

		// Constructor clamping
		expect(driveConsole({ breadth: 0 }).model.breadth).toBe(MIN_SWARM_BREADTH);
		expect(driveConsole({ breadth: 99 }).model.breadth).toBe(MAX_BREADTH);
		expect(driveConsole({ attempts: -5 }).model.attempts).toBe(MIN_ATTEMPTS);
		expect(driveConsole({ attempts: 50 }).model.attempts).toBe(MAX_ATTEMPTS);
		expect(driveConsole({ breadth: Number.NaN }).model.breadth).toBe(MIN_SWARM_BREADTH);
	});

	it("toggles certify on left, right, space, and enter", () => {
		const { model, press } = driveConsole({ certify: true });

		press("certify", LEFT);
		expect(model.certify).toBe(false);
		press("certify", RIGHT);
		expect(model.certify).toBe(true);
		press("certify", " ");
		expect(model.certify).toBe(false);
		press("certify", ENTER);
		expect(model.certify).toBe(true);
		press("certify", "\n");
		expect(model.certify).toBe(false);
	});

	it("steps iterations, takes digits, drops digits on backspace, and renders auto at 0", () => {
		const { model, press, frame } = driveConsole({ maxIterations: null });
		const iterationsRow = (): string => frame().find(line => line.includes("Iterations")) ?? "";

		// Initial 0 is auto
		expect(model.iterations).toBe(0);
		expect(iterationsRow()).toContain("auto");
		expect(model.setup().maxIterations).toBeNull();

		press("iterations", RIGHT);
		expect(model.iterations).toBe(1);
		expect(iterationsRow()).toContain(" 1 ");
		expect(model.setup().maxIterations).toBe(1);

		press("iterations", LEFT);
		expect(model.iterations).toBe(0);
		expect(iterationsRow()).toContain("auto");
		expect(model.setup().maxIterations).toBeNull();

		// Left arrow does not go below 0
		press("iterations", LEFT);
		expect(model.iterations).toBe(0);

		// Digits typed in a row append
		press("iterations", "2");
		expect(model.iterations).toBe(2);
		press("iterations", "5");
		expect(model.iterations).toBe(25);
		press("iterations", "0");
		expect(model.iterations).toBe(250);
		expect(model.setup().maxIterations).toBe(250);

		// Backspace drops one digit
		press("iterations", BACKSPACE);
		expect(model.iterations).toBe(25);
		press("iterations", BACKSPACE);
		expect(model.iterations).toBe(2);
		press("iterations", BACKSPACE);
		expect(model.iterations).toBe(0);
		expect(iterationsRow()).toContain("auto");
		expect(model.setup().maxIterations).toBeNull();
	});

	it("blocks start on empty goal or unknown model and refuses Enter on the start button", () => {
		const empty = driveConsole({ goal: "   " });
		expect(empty.model.startBlocker()).toBe("needs a goal");
		expect(empty.frame().join("\n")).toContain("needs a goal");
		empty.press(ACTION_FIELD, ENTER);
		expect(empty.host.acted).toEqual([]);
		expect(empty.outcomes).toEqual([]);

		const unknown = driveConsole(
			{ goal: "speed", breadth: 2, armModels: ["sonnet", "mystery-ai"] },
			recordingHost({ modelExists: spec => spec === "sonnet" }),
		);
		expect(unknown.model.startBlocker()).toBe('no model matches "mystery-ai"');
		expect(unknown.frame().join("\n")).toContain('no model matches "mystery-ai"');
		unknown.press(ACTION_FIELD, ENTER);
		expect(unknown.host.acted).toEqual([]);
	});

	it("calls host.act('start') and closes on the start button with a valid setup", () => {
		const { model, host, press, outcomes } = driveConsole({
			goal: "make it faster",
			breadth: 2,
			armModels: ["sonnet", "gpt-5"],
		});
		expect(model.startBlocker()).toBeNull();
		press(ACTION_FIELD, ENTER);
		expect(host.acted).toEqual(["start"]);
		expect(outcomes).toEqual(["close"]);
	});

	it("stays open when host.act returns 'stay'", () => {
		const host = recordingHost();
		host.act = action => {
			host.acted.push(action);
			return "stay";
		};
		const { press, outcomes } = driveConsole({ goal: "speed", breadth: 2, certify: false }, host);
		press(ACTION_FIELD, ENTER);
		expect(host.acted).toEqual(["start"]);
		expect(outcomes).toEqual(["stay"]);
	});

	it("sweeps actionsFor across all combinations of session, modeOn, busy, interrupted, and baseline", () => {
		const bools = [false, true];

		for (const hasSession of bools) {
			for (const modeOn of bools) {
				for (const busy of bools) {
					for (const interrupted of bools) {
						for (const baseline of bools) {
							const situation: ConsoleSituation = {
								session: hasSession ? { name: "bench", branch: "autoresearch/bench", runs: 3 } : null,
								harness: true,
								modeOn,
								busy,
								interrupted,
								pausedOnBranch: null,
								baseline,
							};

							const actions = actionsFor(situation);

							if (!hasSession) {
								expect(actions).toEqual(["start"]);
							} else {
								const expected: ConsoleAction[] = [];
								if (modeOn && busy && !interrupted) {
									expected.push("pause");
								} else {
									expected.push("resume");
								}
								expected.push("new");
								if (modeOn) {
									expected.push("stop");
								}
								expected.push("clear");
								if (baseline) {
									expected.push("reset");
								}
								expect(actions).toEqual(expected);
							}
						}
					}
				}
			}
		}
	});

	it("lists every setup field on the form, each under its label, and the button last among them", () => {
		const { form, frame } = driveConsole({ breadth: 3, armModels: ["sonnet", "gpt-5"] });
		// Swept from the label table, so a field added there fails here until the form lists it.
		const ids = Object.keys(FIELD_LABELS) as ConsoleFieldId[];
		const painted = frame();
		for (const id of ids) {
			form.focus(id);
			expect(form.focusedId).toBe(id);
			expect(painted.some(line => line.includes(FIELD_LABELS[id]))).toBe(true);
		}
		form.focus(ACTION_FIELD);
		expect(form.focusedId).toBe(ACTION_FIELD);
		// A row that is no field never takes the ring.
		form.focus("cost");
		expect(form.focusedId).toBe(ACTION_FIELD);
	});

	it("offers 'new' only with a session, blocks it on empty goal or unknown model, and calls host.act('new') once valid", () => {
		expect(actionsFor(NO_SESSION).includes("new")).toBe(false);
		expect(actionsFor(WITH_SESSION).includes("new")).toBe(true);

		// With a session the primary action is Resume; New is a second action
		// the model runs on request, blocked by the same setup rules as Start.
		const empty = driveConsole({ goal: "   " }, recordingHost({ situation: () => WITH_SESSION }));
		expect(empty.model.blocker("new")).toBe("needs a goal");
		expect(empty.model.perform("new")).toBe("refused");
		expect(empty.host.acted).toEqual([]);

		const unknown = driveConsole(
			{ goal: "speed", breadth: 2, armModels: ["sonnet", "mystery-ai"] },
			recordingHost({ situation: () => WITH_SESSION, modelExists: spec => spec === "sonnet" }),
		);
		expect(unknown.model.blocker("new")).toBe('no model matches "mystery-ai"');
		expect(unknown.model.perform("new")).toBe("refused");
		expect(unknown.host.acted).toEqual([]);

		const valid = driveConsole(
			{ goal: "speed", breadth: 2, armModels: ["sonnet"] },
			recordingHost({ situation: () => WITH_SESSION }),
		);
		expect(valid.model.blocker("new")).toBeNull();
		expect(valid.model.perform("new")).toBe("close");
		expect(valid.host.acted).toEqual(["new"]);
		// An action the situation does not offer is refused before the setup is read.
		expect(valid.model.blocker("start")).toBe("not available now");
		expect(valid.model.perform("start")).toBe("refused");
		expect(valid.host.acted).toEqual(["new"]);
	});
});

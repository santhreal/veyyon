/**
 * WHY: the shortest path is open, type the goal, Enter. Before the launcher
 * the cursor opened on Start with nothing to start, Tab was a second Down
 * key, a count took four presses of → to reach 5, a long goal was erased one
 * grapheme at a time, and the footer printed one legend for every row, so the
 * keys a row took were learned from the pane's prose or not at all.
 *
 * The class this closes is a field whose keys are not stated, or whose stated
 * keys do something else: every field of the setup form is swept for a footer
 * hint, and each named key is pressed against the real launcher and the real
 * dashboard.
 *
 * What it does not catch: what the host does with the action once the surface
 * has closed, which `autoswarm-is-its-own-command` drives through the command.
 */
import { describe, expect, it } from "bun:test";
import {
	ACTION_FIELD,
	ACTION_KEYS,
	ACTION_LABELS,
	ACTION_VERBS,
	actionsFor,
	type ConsoleAction,
	type ConsoleSituation,
	FIELD_LABELS,
	LoopConsoleModel,
	type LoopSetup,
	SAVE_FIELD,
} from "@veyyon/coding-agent/autoresearch/console";
import { LauncherComponent } from "@veyyon/coding-agent/autoresearch/launcher";
import { BUILTIN_PRESETS, type LoopPreset } from "@veyyon/coding-agent/autoresearch/presets";
import { AutoresearchScreenComponent, actionBar, footerHint } from "@veyyon/coding-agent/autoresearch/screen";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { MAX_ATTEMPTS, MAX_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { stripAnsi } from "@veyyon/utils";
import { NO_SESSION, type RecordingHost, recordingHost } from "./helpers/autoswarm-console";
import { useTruecolorTheme } from "./helpers/theme-assertions";

const LIVE: ConsoleSituation = {
	...NO_SESSION,
	session: { name: "sess-1", branch: "autoresearch/test", runs: 4 },
	modeOn: true,
	busy: true,
	baseline: true,
};

const SAVED: LoopPreset = {
	name: "mine",
	breadth: 2,
	attempts: 3,
	certify: false,
	armModels: [],
	maxIterations: 7,
	builtin: false,
};

const ENTER = "\r";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DELETE = "\x1b[3~";

const DEFAULTS: LoopSetup = { goal: "", breadth: 1, attempts: 1, certify: false, armModels: [], maxIterations: null };

interface Surface<T> {
	model: LoopConsoleModel;
	host: RecordingHost;
	surface: T;
	closes: number;
	/** Saved presets removed through the host, in order. */
	deleted: string[];
	type: (text: string) => void;
}

function hostFor(situation: ConsoleSituation, deleted: string[]): RecordingHost {
	let presets = [...BUILTIN_PRESETS, SAVED];
	return recordingHost({
		situation: () => situation,
		modelExists: spec => spec !== "nope",
		presets: () => presets,
		deletePreset: name => {
			deleted.push(name);
			presets = presets.filter(preset => preset.name !== name);
			return true;
		},
	});
}

/** The launcher over `situation`, the way `/autoswarm` opens it without a session. */
function launch(situation: ConsoleSituation, initial: Partial<LoopSetup> = {}): Surface<LauncherComponent> {
	const deleted: string[] = [];
	const host = hostFor(situation, deleted);
	const model = new LoopConsoleModel({ ...DEFAULTS, ...initial }, host);
	const out: Surface<LauncherComponent> = {
		model,
		host,
		surface: undefined as never,
		closes: 0,
		deleted,
		type: text => typeInto(out.surface, text),
	};
	out.surface = new LauncherComponent({
		model,
		close: () => {
			out.closes += 1;
		},
		requestRender: () => {},
		rows: () => 30,
	});
	return out;
}

/** The dashboard over `situation`, the way `/autoswarm` opens it over a session. */
function dashboard(
	situation: ConsoleSituation,
	initial: Partial<LoopSetup> = {},
): Surface<AutoresearchScreenComponent> {
	const deleted: string[] = [];
	const host = hostFor(situation, deleted);
	const model = new LoopConsoleModel({ ...DEFAULTS, ...initial }, host);
	const out: Surface<AutoresearchScreenComponent> = {
		model,
		host,
		surface: undefined as never,
		closes: 0,
		deleted,
		type: text => typeInto(out.surface, text),
	};
	out.surface = new AutoresearchScreenComponent({
		runtime: createSessionRuntime(),
		model,
		close: () => {
			out.closes += 1;
		},
		requestRender: () => {},
		rows: () => 30,
	});
	return out;
}

function frameOf(surface: LauncherComponent | AutoresearchScreenComponent, width = 100): string[] {
	return surface.render(width).map(line => stripAnsi(line));
}

/** The label of the field with the ring, read from the frame the way a user reads it. */
function ringRow(surface: LauncherComponent | AutoresearchScreenComponent): string {
	const line = frameOf(surface).find(text => /^. ▸ /.test(text));
	return (
		line
			?.slice(4)
			.split(/ {2}|│/)[0]
			?.trim() ?? ""
	);
}

function footer(surface: LauncherComponent | AutoresearchScreenComponent, width = 100): string {
	return (
		frameOf(surface, width)
			.at(-2)
			?.replace(/[│ ]+$/, "")
			.replace(/^│ /, "") ?? ""
	);
}

function typeInto(surface: LauncherComponent | AutoresearchScreenComponent, text: string): void {
	for (const char of text) surface.handleInput(char);
}

describe("the console starts from the goal row", () => {
	useTruecolorTheme("dark");

	it("opens the launcher on Goal with the caret and the prompt when there is nothing else to do, and on the button otherwise", () => {
		const bare = launch(NO_SESSION);
		expect(ringRow(bare.surface)).toBe("Goal");
		expect(frameOf(bare.surface).join("\n")).toContain("what to optimize");
		expect(ringRow(launch(NO_SESSION, { goal: "make it faster" }).surface)).toBe(`[ ${ACTION_LABELS.start} ]`);
	});

	it("opens the dashboard on the ledger with the action bar, and `e` opens the form on Goal", () => {
		const running = dashboard(LIVE, { goal: "x" });
		expect(running.surface.view).toBe("ledger");
		expect(footer(running.surface, 160)).toBe(
			"p pause   e setup   enter detail   n new session   x stop   c clear session   r reset worktree   ↑↓ row   esc close",
		);
		// A narrow card sheds from the end: the primary action and the card's
		// own keys outlive the destructive actions, which go first.
		expect(footer(running.surface, 60)).toBe("p pause   e setup   enter detail   esc close");
		running.surface.handleInput("e");
		expect(running.surface.view).toBe("setup");
		expect(ringRow(running.surface)).toBe("Goal");
		expect(footer(running.surface, 160)).toBe("type the goal   ↑↓ field   esc back");
	});

	it("starts on Enter from the Goal row once a goal is typed, and not before", () => {
		const d = launch(NO_SESSION);
		d.surface.handleInput(ENTER);
		expect(d.host.acted).toEqual([]);
		expect(d.closes).toBe(0);
		expect(frameOf(d.surface).join("\n")).toContain("needs a goal");
		d.type("make it faster");
		expect(footer(d.surface)).toContain(`enter ${ACTION_VERBS.start}`);
		d.surface.handleInput(ENTER);
		expect(d.host.acted).toEqual(["start"]);
		expect(d.closes).toBe(1);
	});

	it("resumes on Enter from the Goal row over a paused session, and never pauses from it", () => {
		const paused = dashboard({ ...LIVE, busy: false }, { goal: "x" });
		paused.surface.handleInput("e");
		paused.surface.handleInput(ENTER);
		expect(paused.host.acted).toEqual(["resume"]);
		expect(paused.closes).toBe(1);

		const running = dashboard(LIVE, { goal: "x" });
		running.surface.handleInput("e");
		running.surface.handleInput(ENTER);
		expect(running.host.acted).toEqual([]);
		expect(running.closes).toBe(0);
		expect(running.model.goal).toBe("x");
	});

	it("walks the presets with ←→ on the Preset row, wrapping, and Tab moves the ring rather than typing", () => {
		const d = launch(NO_SESSION);
		d.type("goal");
		const names = [...BUILTIN_PRESETS, SAVED].map(preset => preset.name);
		d.surface.handleInput("\t");
		expect(ringRow(d.surface)).toBe("Preset");
		expect(d.model.goal).toBe("goal");
		const seen: string[] = [];
		for (let i = 0; i < names.length + 1; i += 1) {
			d.surface.handleInput(RIGHT);
			seen.push(d.model.presetInForce()?.name ?? "(none)");
		}
		expect(seen).toEqual([...names, names[0]]);
		d.surface.handleInput(LEFT);
		expect(d.model.presetInForce()?.name).toBe(names.at(-1));
		expect(d.model.goal).toBe("goal");
		// Shift+Tab walks the ring back to Goal.
		d.surface.handleInput("\x1b[Z");
		expect(ringRow(d.surface)).toBe("Goal");
	});

	it("removes a saved preset with Delete on the Preset row, and never a built-in one", () => {
		const d = launch(NO_SESSION, {
			goal: "x",
			breadth: SAVED.breadth,
			attempts: SAVED.attempts,
			certify: SAVED.certify,
			maxIterations: SAVED.maxIterations,
		});
		expect(d.model.presetInForce()?.name).toBe(SAVED.name);
		d.surface.focus("preset");
		d.surface.handleInput(DELETE);
		expect(d.deleted).toEqual([SAVED.name]);
		d.surface.handleInput(RIGHT);
		expect(d.model.presetInForce()?.builtin).toBe(true);
		const builtin = d.model.presetInForce()?.name;
		d.surface.handleInput(DELETE);
		expect(d.deleted).toEqual([SAVED.name]);
		expect(d.model.presetInForce()?.name).toBe(builtin);
	});

	it("sets a count from a digit, and swallows a digit past the bound", () => {
		const d = launch(NO_SESSION, { goal: "x" });
		d.surface.focus("breadth");
		d.surface.handleInput(String(MAX_BREADTH));
		expect(d.model.breadth).toBe(MAX_BREADTH);
		d.surface.handleInput("9");
		expect(d.model.breadth).toBe(MAX_BREADTH);
		d.surface.handleInput("0");
		expect(d.model.breadth).toBe(MAX_BREADTH);
		expect(ringRow(d.surface)).toBe("Breadth");
		d.surface.focus("attempts");
		d.surface.handleInput(String(MAX_ATTEMPTS));
		expect(d.model.attempts).toBe(MAX_ATTEMPTS);
		d.surface.handleInput("2");
		expect(d.model.attempts).toBe(2);
		expect(d.model.goal).toBe("x");
	});

	it("clears a text row with ctrl+u", () => {
		const d = launch(NO_SESSION, {
			goal: "a long goal nobody wants to backspace",
			breadth: 2,
			armModels: ["opus", "nope"],
		});
		d.surface.focus("goal");
		d.surface.handleInput("\x15");
		expect(d.model.goal).toBe("");
		d.surface.focus("models");
		d.surface.handleInput("\x15");
		expect(d.model.models).toBe("");
		expect(d.model.unknownModels()).toEqual([]);
		d.surface.focus(SAVE_FIELD);
		d.type("name");
		expect(d.model.presetName).toBe("name");
		d.surface.handleInput("\x15");
		expect(d.model.presetName).toBe("");
	});

	it("names the keys of every field in the footer, and sheds them from the end down to esc", () => {
		const d = launch(NO_SESSION, { goal: "x", breadth: 3 });
		// Every field the form lists, swept from the label table rather than a list here.
		for (const id of [...Object.keys(FIELD_LABELS), SAVE_FIELD, ACTION_FIELD]) {
			const hint = d.model.hint(id);
			expect(hint.length).toBeGreaterThan(0);
			const segments = [hint, "↑↓ field"];
			const wide = footerHint(200, segments);
			for (const segment of segments) expect(wide).toContain(segment);
			expect(wide.endsWith("esc close")).toBe(true);
			// Narrower than the first segment: nothing but the exit survives.
			expect(footerHint(13, segments)).toBe("esc close");
			expect(footerHint(11, segments)).toBe("esc");
		}
		// The footer on screen is the field with the ring's.
		d.surface.focus("goal");
		expect(footer(d.surface)).toBe(`type the goal · enter ${ACTION_VERBS.start}   ↑↓ field   esc close`);
		d.surface.focus("preset");
		expect(footer(d.surface)).toBe("←→ preset · del removes a saved one   ↑↓ field   esc close");
		d.surface.focus(ACTION_FIELD);
		expect(footer(d.surface)).toBe(`enter ${ACTION_VERBS.start}   ↑↓ field   esc close`);
	});

	it("names Enter's verb on the button, and a key for every action the loop can offer", () => {
		const situations: ConsoleSituation[] = [
			NO_SESSION,
			LIVE,
			{ ...LIVE, busy: false },
			{ ...LIVE, interrupted: true },
			{ ...LIVE, modeOn: false, busy: false },
			{ ...LIVE, busy: false, pausedOnBranch: "other" },
		];
		const offered = new Set<ConsoleAction>();
		for (const situation of situations) {
			const d = dashboard(situation, { goal: "x" });
			const bar = actionBar(d.model);
			for (const action of actionsFor(situation)) {
				offered.add(action);
				expect(bar).toContain(`${ACTION_KEYS[action]} ${ACTION_LABELS[action].toLowerCase()}`);
			}
			const primary = d.model.primaryAction();
			expect(d.model.hint(ACTION_FIELD)).toBe(`enter ${ACTION_VERBS[primary]}`);
			expect(actionsFor(situation)[0]).toBe(primary);
		}
		// Every action the console knows was reached by some situation above.
		const known: ConsoleAction[] = ["start", "resume", "pause", "new", "stop", "clear", "reset"];
		expect([...offered].sort()).toEqual([...known].sort());
		expect(launch(NO_SESSION).model.hint(SAVE_FIELD)).toBe("type a name · enter saves");
	});
});

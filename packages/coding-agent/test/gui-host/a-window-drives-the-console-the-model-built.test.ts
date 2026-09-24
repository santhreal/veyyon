/**
 * WHY: `/autoswarm` was a terminal-only surface. The command built a
 * `LoopConsoleModel`, asked the registry for a surface to draw it on, found
 * the terminal's one or none, and a window got a warning that the console
 * needs an interactive terminal -- on a host that has a window open. The
 * defect class is a command whose model exists on both hosts and whose
 * surface exists on one.
 *
 * The contract: a window drives the console the model built. Every row the
 * form declares is drawable and settable, a value of the wrong kind is
 * refused rather than dropped, an action the model blocks is refused with the
 * model's own reason, and an action that closes the console ends the wait the
 * command is in. Nothing is decided twice: the setup the window edits is the
 * setup the host persists, and the words on a refusal are the model's.
 *
 * The variant space is swept from source: the row kinds come from the wire's
 * own roster and the actions from `ALL_AUTOSWARM_ACTIONS`, so a kind or an
 * action added to the protocol turns this red until it is driven here.
 *
 * What it does not catch: how the console is painted. A row that carries the
 * right value into a window that draws it wrong is a surface defect, and the
 * desktop surface owns that.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ConsoleAction,
	type ConsoleHost,
	type ConsoleSituation,
	LoopConsoleModel,
	type LoopSetup,
} from "@veyyon/coding-agent/autoresearch/console";
import { autoresearchUiFor } from "@veyyon/coding-agent/autoresearch/dashboard";
import { deletePreset, loadPresets, savePreset } from "@veyyon/coding-agent/autoresearch/presets";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionContext, ExtensionUIContext } from "@veyyon/coding-agent/extensibility/extensions/types";
import {
	AutoswarmConsole,
	attachAutoswarmConsole,
	guiAutoswarmUi,
} from "@veyyon/coding-agent/gui-host/autoswarm-bridge";
import {
	ALL_AUTOSWARM_ACTIONS,
	ALL_AUTOSWARM_FIELD_KINDS,
	type AutoswarmConsoleView,
	type AutoswarmFieldView,
} from "@veyyon/coding-agent/gui-host/wire";

const SESSION = "session-under-test";

/** Every frame the window received, newest last. */
interface Wire {
	socket: net.Socket;
	consoles: Array<AutoswarmConsoleView | null>;
}

function wire(): Wire {
	const consoles: Array<AutoswarmConsoleView | null> = [];
	const socket = {
		destroyed: false,
		write(payload: string): boolean {
			const frame: unknown = JSON.parse(payload);
			if (typeof frame !== "object" || frame === null || !("Snapshot" in frame)) return true;
			const section = (frame as { Snapshot: Record<string, unknown> }).Snapshot;
			const console = section.AutoswarmConsole as { console: AutoswarmConsoleView | null } | undefined;
			if (console) consoles.push(console.console);
			return true;
		},
	};
	return { socket: socket as unknown as net.Socket, consoles };
}

function situation(overrides: Partial<ConsoleSituation> = {}): ConsoleSituation {
	return {
		session: null,
		harness: true,
		modeOn: false,
		busy: false,
		interrupted: false,
		pausedOnBranch: null,
		baseline: false,
		...overrides,
	};
}

interface Driven {
	model: LoopConsoleModel;
	applied: LoopSetup[];
	acted: ConsoleAction[];
}

/**
 * A console model on a real preset store, driven by a host that records what
 * the window's edits reach.
 */
function drive(state: ConsoleSituation, closeOn: ConsoleAction[] = ["start"]): Driven {
	const applied: LoopSetup[] = [];
	const acted: ConsoleAction[] = [];
	const host: ConsoleHost = {
		situation: () => state,
		modelExists: spec => spec === "sonnet",
		presets: () => loadPresets(),
		savePreset: preset => savePreset(preset),
		deletePreset: name => deletePreset(name),
		apply: setup => {
			applied.push(setup);
		},
		act: action => {
			acted.push(action);
			return closeOn.includes(action) ? "close" : "stay";
		},
	};
	const model = new LoopConsoleModel(
		{ goal: "", breadth: 3, attempts: 1, certify: true, armModels: [], maxIterations: null },
		host,
	);
	return { model, applied, acted };
}

function rowOf(view: AutoswarmConsoleView | null, id: string): AutoswarmFieldView {
	const row = view?.fields.find(field => field.id === id);
	if (!row) throw new Error(`no '${id}' row on the console`);
	return row;
}

function runtimeWithRuns(): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.name = "cold-start";
	runtime.state.goal = "cut the cold start";
	runtime.state.metricName = "wall time";
	runtime.state.metricUnit = "ms";
	runtime.state.bestDirection = "lower";
	return runtime;
}

describe("a window drives the console the model built", () => {
	let store: string;
	let previousDir: string | undefined;

	beforeEach(() => {
		store = fs.mkdtempSync(path.join(os.tmpdir(), "autoswarm-console-"));
		previousDir = process.env.VEYYON_AUTORESEARCH_DB_DIR;
		process.env.VEYYON_AUTORESEARCH_DB_DIR = store;
	});

	afterEach(() => {
		if (previousDir === undefined) delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		else process.env.VEYYON_AUTORESEARCH_DB_DIR = previousDir;
		fs.rmSync(store, { recursive: true, force: true });
	});

	test("opening publishes every row of the form, over every kind the protocol declares", () => {
		const { socket, consoles } = wire();
		const { model } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);

		void surface.open(runtimeWithRuns(), model);

		const view = consoles.at(-1);
		expect(view?.session).toBe(SESSION);
		const kinds = new Set(view?.fields.map(field => field.kind));
		expect([...kinds].sort()).toEqual([...ALL_AUTOSWARM_FIELD_KINDS].sort());
		// The notes are the console's own summaries, carried beside the rows
		// rather than restated: the window draws what the model computed.
		expect(view?.notes.map(note => note.id)).toEqual(["cost", "models-summary", "harness"]);
		expect(rowOf(view ?? null, "breadth").display).toBe("3 arms");
	});

	test("the console names the row a preset is saved under", () => {
		const { socket, consoles } = wire();
		const { model } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);

		void surface.open(runtimeWithRuns(), model);

		const view = consoles.at(-1) ?? null;
		// The save row is an ordinary text row; what `save_field` adds is
		// which one it is, so the window draws the save control beside that
		// row rather than matching on a name it hardcoded.
		expect(view?.save_field).toBe("save");
		expect(rowOf(view, "save").kind).toBe("Text");
		expect(surface.setField("save", { text: "nightly" })).toBeNull();
		expect(rowOf(consoles.at(-1) ?? null, "save").text).toBe("nightly");
	});

	test("a row set from the window is a row the host persists", () => {
		const { socket, consoles } = wire();
		const { model, applied } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);

		expect(surface.setField("goal", { text: "cut the cold start" })).toBeNull();
		expect(surface.setField("breadth", { number: 5 })).toBeNull();
		expect(surface.setField("certify", { on: false })).toBeNull();
		expect(surface.setField("preset", { text: "wide" })).toBeNull();

		expect(model.goal).toBe("cut the cold start");
		expect(model.certify).toBe(true);
		// The preset is the last edit and it sets the whole shape, which is
		// why breadth reads the preset's 5 rather than the stepper's.
		expect(model.breadth).toBe(5);
		expect(applied.at(-1)).toMatchObject({ goal: "cut the cold start", breadth: 5, certify: true });
		expect(rowOf(consoles.at(-1) ?? null, "preset").display).toBe("wide");
	});

	test("a value of the wrong kind is refused and the row keeps what it had", () => {
		const { socket } = wire();
		const { model, applied } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);

		expect(surface.setField("breadth", { text: "5" })?.code).toBe("INVALID_ARGUMENTS");
		expect(surface.setField("certify", { number: 1 })?.code).toBe("INVALID_ARGUMENTS");
		expect(surface.setField("goal", { on: true })?.code).toBe("INVALID_ARGUMENTS");
		expect(surface.setField("preset", { text: "no-such-preset" })?.code).toBe("OPTION_NOT_FOUND");
		expect(surface.setField("nothing-here", { text: "x" })?.code).toBe("FIELD_NOT_FOUND");

		expect(model.breadth).toBe(3);
		expect(model.certify).toBe(true);
		expect(model.goal).toBe("");
		expect(applied).toEqual([]);
	});

	test("a stepper is held inside the bounds the form declares", () => {
		const { socket, consoles } = wire();
		const { model } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);
		const { min, max } = rowOf(consoles.at(-1) ?? null, "breadth");
		if (min === null || max === null) throw new Error("the stepper row states no bounds");

		expect(surface.setField("breadth", { number: 9999 })).toBeNull();
		expect(model.breadth).toBe(max);
		expect(surface.setField("breadth", { number: -4 })).toBeNull();
		expect(model.breadth).toBe(min);
	});

	test("an action the model blocks is refused with the model's own reason", () => {
		const { socket } = wire();
		const { model, acted } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);

		// The goal is empty, which is what the model states blocks a start.
		const refusal = surface.act("start");
		expect(refusal?.code).toBe("ACTION_BLOCKED");
		expect(refusal?.message).toContain(model.blocker("start") ?? "");
		expect(acted).toEqual([]);
	});

	test("every action the protocol declares is refused or run, never dropped", () => {
		const { socket } = wire();
		const { model, acted } = drive(
			situation({ modeOn: true, busy: true, session: { name: "s", branch: null, runs: 2 } }),
			[],
		);
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);
		surface.setField("goal", { text: "cut the cold start" });

		const offered = new Set(model.actions());
		for (const action of ALL_AUTOSWARM_ACTIONS) {
			const refusal = surface.act(action);
			if (offered.has(action)) expect(refusal).toBeNull();
			else expect(refusal?.code).toBe("ACTION_BLOCKED");
		}
		expect(acted).toEqual([...offered]);
	});

	test("an action that closes the console ends the wait the command is in", async () => {
		const { socket, consoles } = wire();
		const { model, acted } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		const open = surface.open(runtimeWithRuns(), model);
		surface.setField("goal", { text: "cut the cold start" });

		expect(surface.act("start")).toBeNull();
		await open;

		expect(acted).toEqual(["start"]);
		expect(surface.isOpen).toBe(false);
		// The window is told the console is gone, so nothing is left drawn on
		// a surface the session is no longer holding open.
		expect(consoles.at(-1)).toBeNull();
	});

	test("closing the console from the window ends the same wait", async () => {
		const { socket, consoles } = wire();
		const { model, acted } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		const open = surface.open(runtimeWithRuns(), model);

		surface.close();
		await open;

		expect(acted).toEqual([]);
		expect(consoles.at(-1)).toBeNull();
		expect(surface.act("start")?.code).toBe("NO_CONSOLE");
		expect(surface.setField("goal", { text: "x" })?.code).toBe("NO_CONSOLE");
	});

	test("a preset saved from the window is offered back, and deleting it takes it away", () => {
		const { socket, consoles } = wire();
		const { model } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);
		// A shape no built-in holds, so the saved preset is the one in force:
		// the console marks the first preset the rows equal, and the built-ins
		// are read first.
		surface.setField("attempts", { number: 2 });
		expect(surface.savePreset("nightly")).toBeNull();
		const saved = rowOf(consoles.at(-1) ?? null, "preset").options.find(option => option.value === "nightly");
		expect(saved).toMatchObject({ selected: true, removable: true });
		// A built-in is offered and cannot be taken away, which is what keeps
		// the fixed points the saved ones are read against.
		expect(rowOf(consoles.at(-1) ?? null, "preset").options.find(option => option.value === "swarm")).toMatchObject({
			removable: false,
		});

		expect(surface.deletePreset()).toBeNull();
		expect(loadPresets().some(preset => preset.name === "nightly")).toBe(false);
		expect(surface.deletePreset()?.code).toBe("PRESET_NOT_DELETED");
	});

	test("a preset the store refuses is stated, not silently dropped", () => {
		const { socket } = wire();
		const { model } = drive(situation());
		const surface = new AutoswarmConsole(socket, () => SESSION);
		void surface.open(runtimeWithRuns(), model);

		// `swarm` is built in: the store refuses to save over it.
		expect(surface.savePreset("swarm")?.code).toBe("PRESET_NOT_SAVED");
		expect(loadPresets().filter(preset => preset.name === "swarm")).toHaveLength(1);
	});

	test("the window host draws only where a console is attached", () => {
		const { socket } = wire();
		const surface = new AutoswarmConsole(socket, () => SESSION);
		const ui = {} as ExtensionUIContext;
		const attached = { ui, hasUI: true } as ExtensionContext;
		const elsewhere = { ui: {} as ExtensionUIContext, hasUI: true } as ExtensionContext;

		attachAutoswarmConsole(ui, surface);

		expect(guiAutoswarmUi.claims?.(attached)).toBe(true);
		expect(guiAutoswarmUi.claims?.(elsewhere)).toBe(false);
		expect(autoresearchUiFor(attached)).toBe(guiAutoswarmUi);
		// A context this host holds no console for is drawn by nothing here:
		// the warning the command states is the true reading of it.
		expect(autoresearchUiFor(elsewhere)).toBeNull();
	});
});

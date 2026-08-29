/**
 * WHY: `/autoswarm` is configured in a console rather than through command
 * arguments, so every rule a user relies on lives in keystroke handling: which
 * row the keys reach, where a value stops, whether Enter can start a run that
 * has nothing to optimize.
 *
 * The class this closes is a key acting on the wrong row, or acting where it
 * should not act at all — typing that edits a number, space that inserts a
 * character into a toggle, an arrow that walks past a bound, Enter that starts
 * an empty run. Each is invisible to a type check, because every field is a
 * property on one object and every key is a string.
 *
 * What it does not catch: how the frame looks. Colour, spacing and clipping are
 * the renderer's, and this suite reads a passthrough theme.
 */
import { describe, expect, it } from "bun:test";
import {
	handleSetupKey,
	renderSetupConsole,
	SWARM_SETUP_SHORTCUTS,
	SwarmSetupModel,
	setupRows,
} from "@veyyon/coding-agent/autoresearch/setup-console";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { passthroughTheme } from "./helpers/passthrough-theme";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";

function fresh(overrides: Partial<{ goal: string; breadth: number; attempts: number; certify: boolean }> = {}) {
	return new SwarmSetupModel({ goal: "make it faster", breadth: 3, attempts: 1, certify: true, ...overrides });
}

function feed(model: SwarmSetupModel, keys: string[]): Array<"start" | "cancel" | null> {
	return keys.map(key => handleSetupKey(model, key));
}

const theme = passthroughTheme();

describe("the autoswarm console configures a run before it starts", () => {
	it("walks every field and wraps in both directions", () => {
		// Every row must be reachable. A row the cursor cannot land on is a
		// setting nobody can change, which is the same as not shipping it.
		const model = fresh();
		const ids = setupRows(model).map(row => row.id);
		expect(ids).toEqual(["goal", "breadth", "attempts", "certify"]);

		const seen: string[] = [model.field];
		for (let index = 0; index < ids.length; index++) {
			handleSetupKey(model, DOWN);
			seen.push(model.field);
		}
		expect(seen).toEqual(["goal", "breadth", "attempts", "certify", "goal"]);

		handleSetupKey(model, UP);
		expect(model.field).toBe("certify");
	});

	it("clamps each number at both ends rather than running past them", () => {
		const model = fresh({ breadth: MIN_BREADTH, attempts: MIN_ATTEMPTS });
		handleSetupKey(model, DOWN);
		feed(model, Array<string>(MAX_BREADTH + 4).fill(RIGHT));
		expect(model.breadth).toBe(MAX_BREADTH);
		feed(model, Array<string>(MAX_BREADTH + 4).fill(LEFT));
		expect(model.breadth).toBe(MIN_BREADTH);

		handleSetupKey(model, DOWN);
		feed(model, Array<string>(MAX_ATTEMPTS + 4).fill(RIGHT));
		expect(model.attempts).toBe(MAX_ATTEMPTS);
		feed(model, Array<string>(MAX_ATTEMPTS + 4).fill(LEFT));
		expect(model.attempts).toBe(MIN_ATTEMPTS);
	});

	it("clamps a value it was constructed with, not only one the keys produced", () => {
		// The console opens on a session's stored breadth. A database row from a
		// future version, or a hand-edited one, must not put the cursor on a
		// value the arrows cannot leave.
		expect(fresh({ breadth: 99 }).breadth).toBe(MAX_BREADTH);
		expect(fresh({ breadth: 0 }).breadth).toBe(MIN_BREADTH);
		expect(fresh({ attempts: 99 }).attempts).toBe(MAX_ATTEMPTS);
		expect(fresh({ attempts: -3 }).attempts).toBe(MIN_ATTEMPTS);
		expect(fresh({ breadth: Number.NaN }).breadth).toBe(MIN_BREADTH);
	});

	it("types into the goal and nowhere else", () => {
		const model = fresh({ goal: "" });
		feed(model, ["g", "o", " ", "f", "a", "s", "t"]);
		expect(model.goal).toBe("go fast");

		// On a number row the same characters must not become text, and must not
		// silently edit the number either.
		handleSetupKey(model, DOWN);
		const breadthBefore = model.breadth;
		feed(model, ["7", "x"]);
		expect(model.goal).toBe("go fast");
		expect(model.breadth).toBe(breadthBefore);
	});

	it("uses space to toggle off the goal row and as a character on it", () => {
		const model = fresh({ goal: "a", certify: true });
		handleSetupKey(model, " ");
		expect(model.goal).toBe("a ");
		expect(model.certify).toBe(true);

		feed(model, [DOWN, DOWN, DOWN, " "]);
		expect(model.field).toBe("certify");
		expect(model.certify).toBe(false);
		expect(model.goal).toBe("a ");
		handleSetupKey(model, " ");
		expect(model.certify).toBe(true);
	});

	it("backspaces the goal and stops at empty without throwing", () => {
		const model = fresh({ goal: "ab" });
		feed(model, [BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE]);
		expect(model.goal).toBe("");

		// Backspace on a number row must not decrement it, and must not reach
		// back into the goal either — the row it would silently eat.
		const numbers = fresh({ goal: "keep me", breadth: 3 });
		handleSetupKey(numbers, DOWN);
		feed(numbers, [BACKSPACE, BACKSPACE]);
		expect(numbers.breadth).toBe(3);
		expect(numbers.goal).toBe("keep me");
	});

	it("refuses to start without a goal, and reports why on screen", () => {
		const model = fresh({ goal: "   " });
		expect(model.canStart()).toBe(false);
		expect(handleSetupKey(model, ENTER)).toBeNull();
		expect(renderSetupConsole(model, 80, theme).join("\n")).toContain("A goal is required");

		handleSetupKey(model, "x");
		expect(model.canStart()).toBe(true);
		expect(handleSetupKey(model, ENTER)).toBe("start");
		expect(renderSetupConsole(model, 80, theme).join("\n")).not.toContain("A goal is required");
	});

	it("cancels on escape from any field", () => {
		for (const prefix of [[], [DOWN], [DOWN, DOWN], [DOWN, DOWN, DOWN]]) {
			const model = fresh();
			feed(model, prefix);
			expect(handleSetupKey(model, ESCAPE)).toBe("cancel");
		}
	});

	it("hands back a trimmed goal with the values that were set", () => {
		const model = fresh({ goal: "  make startup faster  ", breadth: 3, attempts: 1, certify: true });
		feed(model, [DOWN, RIGHT, DOWN, RIGHT, DOWN, " ", ENTER]);
		expect(model.result()).toEqual({ goal: "make startup faster", breadth: 4, attempts: 2, certify: false });
	});

	it("states what the chosen breadth actually buys", () => {
		// Breadth 2 cannot form a ring, because two arms would review each other.
		// A console that says "review ring" at breadth 2 is lying about the run.
		expect(fresh({ breadth: 1 }).certifierSummary()).toContain("Serial");
		expect(fresh({ breadth: 2 }).certifierSummary()).toContain("director");
		expect(fresh({ breadth: 2 }).certifierSummary()).not.toContain("review ring");
		expect(fresh({ breadth: 3 }).certifierSummary()).toContain("review ring");
		expect(fresh({ breadth: 4, certify: false }).certifierSummary()).toContain("uncertified");
	});

	it("renders every row and the current values", () => {
		const model = fresh({ goal: "make it faster", breadth: 5, attempts: 2, certify: false });
		const frame = renderSetupConsole(model, 80, theme).join("\n");
		for (const label of ["Goal", "Breadth", "Attempts", "Certification"]) {
			expect(frame).toContain(label);
		}
		expect(frame).toContain("make it faster");
		expect(frame).toContain("5");
		expect(frame).toContain("off");
	});

	/**
	 * WHY: the card footer is the only statement of which keys this console
	 * answers, and it is built from a list the key handler never reads. A chip
	 * naming a chord the handler ignores is a lie drawn on screen, and adding a
	 * chip is exactly when that happens.
	 *
	 * CLASS: an advertised chord no handler answers. Enumerated from the exported
	 * chip list, so a new chip fails here until its key is recorded.
	 *
	 * GAP: says nothing about where the chip is painted; that is the shell's.
	 */
	it("answers every chord its footer advertises", () => {
		// Which keys a chip stands for, and the field the chord has to act on.
		const chords: Record<string, { keys: string[]; onField: number }> = {
			"up/down field": { keys: [UP, DOWN], onField: 0 },
			"left/right adjust": { keys: [LEFT, RIGHT], onField: 1 },
			"space toggle": { keys: [" "], onField: 3 },
			"enter start": { keys: [ENTER], onField: 0 },
			"esc cancel": { keys: [ESCAPE], onField: 0 },
		};
		expect(SWARM_SETUP_SHORTCUTS.map(chip => chip.label)).toEqual(Object.keys(chords));

		for (const [label, { keys, onField }] of Object.entries(chords)) {
			for (const key of keys) {
				const model = fresh();
				for (let step = 0; step < onField; step++) handleSetupKey(model, DOWN);
				const before = JSON.stringify({ ...model.result(), field: model.field });
				const outcome = handleSetupKey(model, key);
				const after = JSON.stringify({ ...model.result(), field: model.field });
				// A chord either leaves the console or changes the form. One that does
				// neither is a chip for a key nothing handles.
				expect(`${label} ${key}: ${outcome !== null || before !== after}`).toBe(`${label} ${key}: true`);
			}
		}

		// The exit chip is the one the card hit-tests a click against.
		const exit = SWARM_SETUP_SHORTCUTS.find(chip => chip.label === "esc cancel");
		expect(exit?.clickable).toBe(true);
		expect(exit?.id).toBe("close");
	});

	it("lines the hints up in one column whatever the values are", () => {
		// `on` is two cells and `3` is one, so a hint appended straight after the
		// value hangs at a different place on every row and reads as ragged.
		const model = fresh({ breadth: 3, attempts: 1, certify: true });
		const frame = renderSetupConsole(model, 100, theme);
		const hinted = frame.filter(
			line => line.includes("  candidate") || line.includes("  arms cross-review") || line.includes("  retries"),
		);
		expect(hinted).toHaveLength(3);
		const columns = hinted.map(line => line.search(/ {2}(candidate|retries|arms cross-review)/));
		expect(new Set(columns).size).toBe(1);

		// And it stays one column when a value changes width.
		handleSetupKey(model, DOWN);
		feed(model, [DOWN, DOWN, " "]);
		expect(model.certify).toBe(false);
		const after = renderSetupConsole(model, 100, theme)
			.filter(line => / {2}(candidate|retries|arms cross-review)/.test(line))
			.map(line => line.search(/ {2}(candidate|retries|arms cross-review)/));
		expect(new Set(after).size).toBe(1);
	});

	it("shows a placeholder for an empty goal instead of a blank row", () => {
		const frame = renderSetupConsole(fresh({ goal: "" }), 80, theme).join("\n");
		expect(frame).toContain("what should get faster?");
	});

	it("keeps every rendered line inside the given width", () => {
		// The console is an overlay. A line wider than the terminal wraps and
		// pushes the legend off screen, which is how a user loses the exit key.
		const model = fresh({ goal: "x".repeat(400) });
		for (const width of [40, 60, 80, 120]) {
			for (const line of renderSetupConsole(model, width, theme)) {
				expect(line.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("wraps its sentences onto a second line instead of cutting their ends off", () => {
		// The console renders inside a card that is narrower than the terminal,
		// so both of its sentences are wider than the width they are handed.
		// Clipping them dropped the end of each one on screen: the summary lost
		// what the chosen breadth buys, which is the only place that is stated.
		const model = fresh({ goal: "make the tokenizer faster" });
		const plain = renderSetupConsole(model, 56, theme).join(" ").replace(/\s+/g, " ");
		expect(plain).toContain("The model derives the metric from your harness.");
		expect(plain).toContain(model.certifierSummary());
	});

	it("keeps the end of a long goal in view instead of running off the edge", () => {
		// Typing past the right edge must keep showing the characters being
		// typed. A left-anchored value freezes on screen while the goal grows,
		// so the user cannot see what they are writing.
		const model = fresh({ goal: "" });
		feed(model, "make the cold start of the whole binary measurably faster".split(""));
		const frame = renderSetupConsole(model, 60, theme).join("\n");
		expect(frame).toContain("faster");
		expect(frame).toContain("…");
		expect(frame).not.toContain("make the cold start");
	});

	it("ignores an unhandled escape sequence rather than typing it", () => {
		// A function key or a mouse report must not land in the goal as literal
		// bracket-codes, which is what a naive printable check would do.
		const model = fresh({ goal: "keep" });
		for (const sequence of ["\x1b[5~", "\x1b[15~", "\x1bOP", "\x1b[M   "]) {
			expect(handleSetupKey(model, sequence)).toBeNull();
		}
		expect(model.goal).toBe("keep");
	});
});

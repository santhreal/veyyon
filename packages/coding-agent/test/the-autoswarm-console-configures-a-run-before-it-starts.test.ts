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
	SwarmSetupModel,
	setupRows,
} from "@veyyon/coding-agent/autoresearch/setup-console";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";

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

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderSetupConsole>[2];

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

	it("refuses to start without a goal, and reports why on the key that refuses", () => {
		const model = fresh({ goal: "   " });
		expect(model.canStart()).toBe(false);
		expect(handleSetupKey(model, ENTER)).toBeNull();
		// The report is on the legend, beside `enter`, rather than a warning line
		// somewhere above it: a legend that promises `enter start` while enter does
		// nothing is the console contradicting itself.
		const refusing = renderSetupConsole(model, 80, theme).join("\n");
		expect(refusing).toContain("enter needs a goal");
		expect(refusing).not.toContain("enter start");

		handleSetupKey(model, "x");
		expect(model.canStart()).toBe(true);
		expect(handleSetupKey(model, ENTER)).toBe("start");
		const starting = renderSetupConsole(model, 80, theme).join("\n");
		expect(starting).toContain("enter start");
		expect(starting).not.toContain("enter needs a goal");
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
		// Breadth 2 cannot form a ring, because two arms would review each other,
		// so the director reviews both. A console that describes a ring at breadth
		// 2 is lying about the run. The arm count is on the cost line above this
		// one, so this sentence carries only the topology.
		expect(fresh({ breadth: 1 }).certifierSummary()).toContain("Serial");
		expect(fresh({ breadth: 2 }).certifierSummary()).toContain("director");
		expect(fresh({ breadth: 2 }).certifierSummary()).not.toContain("reviewed by another");
		expect(fresh({ breadth: 3 }).certifierSummary()).toContain("reviewed by another");
		expect(fresh({ breadth: 3 }).certifierSummary()).not.toContain("director");
		expect(fresh({ breadth: 4, certify: false }).certifierSummary()).toContain("No cross-review");
	});

	it("renders every row, the current values and the key legend", () => {
		const model = fresh({ goal: "make it faster", breadth: 5, attempts: 2, certify: false });
		const frame = renderSetupConsole(model, 80, theme).join("\n");
		for (const label of ["Goal", "Breadth", "Attempts", "Certification"]) {
			expect(frame).toContain(label);
		}
		expect(frame).toContain("make it faster");
		expect(frame).toContain("5");
		expect(frame).toContain("off");
		expect(frame).toContain("esc cancel");
	});

	it("lines the hints up in one column whatever the values are", () => {
		// `on` is two cells and `3` is one, so a hint appended straight after the
		// value hangs at a different place on every row and reads as ragged.
		//
		// The hints come from `setupRows` rather than from three strings copied
		// into this file: a reworded hint used to fall out of the filter and take
		// its row's alignment out of the assertion with it, and a fourth hinted
		// field would never have been checked at all.
		const model = fresh({ breadth: 3, attempts: 1, certify: true });
		const hintColumns = (candidate: SwarmSetupModel): number[] =>
			setupRows(candidate)
				.filter(row => row.hint.length > 0)
				.map(row => {
					const line = renderSetupConsole(candidate, 100, theme).find(text => text.includes(`  ${row.hint}`));
					// -1 for a hint the console did not print, so a dropped row fails
					// here rather than quietly shrinking the set below.
					return line === undefined ? -1 : line.indexOf(`  ${row.hint}`);
				});

		const columns = hintColumns(model);
		expect(columns).toHaveLength(3);
		expect(columns.every(column => column > 0)).toBe(true);
		expect(new Set(columns).size).toBe(1);

		// And it stays one column when a value changes width.
		handleSetupKey(model, DOWN);
		feed(model, [DOWN, DOWN, " "]);
		expect(model.certify).toBe(false);
		expect(hintColumns(model)).toEqual(columns);
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

	it("states the harness runs the configuration commits to, at every reachable setting", () => {
		// Breadth and attempts multiply, and neither row says so: breadth 4 with
		// 3 attempts is twelve builds and twelve measurements per iteration. A
		// user setting the second knob cannot see the cost of the first, which is
		// how a loop meant to run over lunch gets configured to run overnight.
		for (let breadth = MIN_BREADTH; breadth <= MAX_BREADTH; breadth += 1) {
			for (let attempts = MIN_ATTEMPTS; attempts <= MAX_ATTEMPTS; attempts += 1) {
				const model = fresh({ breadth, attempts });
				const flat = renderSetupConsole(model, 100, theme).join("\n").replace(/\s+/g, " ");
				const total = breadth * attempts;
				const expected =
					total === 1
						? `${breadth} experiment × ${attempts} attempts: 1 harness run per iteration.`
						: `${breadth} ${breadth === 1 ? "experiment" : "arms"} × ${attempts} attempts: up to ${total} harness runs per iteration.`;
				expect(flat).toContain(expected);
			}
		}
	});

	it("holds its height while the goal is emptied and retyped", () => {
		// The refusal used to be a line of its own that appeared the moment the
		// goal was cleared, so the legend moved under the reader's eye on the
		// keystroke that cleared it and moved back on the one that fixed it.
		// What the legend then says is the previous test's; this one is the shape.
		const model = fresh({ goal: "x" });
		const withGoal = renderSetupConsole(model, 80, theme);
		handleSetupKey(model, BACKSPACE);
		expect(model.goal).toBe("");
		expect(renderSetupConsole(model, 80, theme).length).toBe(withGoal.length);
	});
});

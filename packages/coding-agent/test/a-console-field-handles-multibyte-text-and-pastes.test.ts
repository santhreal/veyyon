/**
 * WHY: the text fields of the autoswarm setup form take freeform input (a
 * goal, a model list), so a backspace must drop a whole grapheme cluster
 * rather than a UTF-16 code unit (which leaves a surrogate pair split or a
 * combining mark detached), a pasted chunk with line breaks or tabs must be
 * flattened rather than rejected whole, an escape sequence must never type
 * its bytes into a field, and every edit must reach the host through
 * `host.apply(model.setup())`.
 *
 * The class this closes is text field corruption, broken multibyte deletion,
 * key sequence bytes leaking into a field, and a host whose configuration
 * lags what is on screen.
 *
 * What it does not catch: terminal-level IME composition or the PTY's own
 * encoding, which are decided before a key reaches the form.
 */
import { describe, expect, it } from "bun:test";
import { MAX_BREADTH, MIN_SWARM_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { driveConsole } from "./helpers/autoswarm-console";
import { useTruecolorTheme } from "./helpers/theme-assertions";

const BACKSPACE = "\x7f";
const RIGHT = "\x1b[C";

describe("a console field handles multibyte text and pastes", () => {
	useTruecolorTheme("dark");

	it("deletes a multi-byte emoji or combining mark in a single backspace on the Goal row", () => {
		const { model, host, press } = driveConsole({ goal: "optimize 🚀" });

		// One backspace removes the whole emoji, leaving no orphan surrogate.
		press("goal", BACKSPACE);
		expect(model.goal).toBe("optimize ");
		expect(host.applied.at(-1)?.goal).toBe("optimize");

		press("goal", "e\u0301");
		expect(model.goal).toBe("optimize e\u0301");
		press("goal", BACKSPACE);
		expect(model.goal).toBe("optimize ");

		press("goal", "优化");
		expect(model.goal).toBe("optimize 优化");
		press("goal", BACKSPACE);
		expect(model.goal).toBe("optimize 优");
		press("goal", BACKSPACE);
		expect(model.goal).toBe("optimize ");
	});

	it("deletes a multi-byte emoji or combining mark in a single backspace on the Models row", () => {
		const { model, host, press } = driveConsole({ armModels: ["sonnet", "gpt-5🚀"] });
		expect(model.models).toBe("sonnet, gpt-5🚀");

		press("models", BACKSPACE);
		expect(model.models).toBe("sonnet, gpt-5");
		expect(host.applied.at(-1)?.armModels).toEqual(["sonnet", "gpt-5"]);

		press("models", "e\u0301");
		expect(model.models).toBe("sonnet, gpt-5e\u0301");
		press("models", BACKSPACE);
		expect(model.models).toBe("sonnet, gpt-5");
		expect(host.applied.at(-1)?.armModels).toEqual(["sonnet", "gpt-5"]);
	});

	it("types nothing from an ESC-bearing chunk into text fields", () => {
		const { model, host, press } = driveConsole({ goal: "start", armModels: ["sonnet", "gpt-5"] });

		// An arrow moves the caret; a function key and a chunk with a stray ESC type nothing.
		press("goal", "\x1b[D", "\x1b[C", "\x1bOP", "paste \x1b with escape");
		expect(model.goal).toBe("start");

		press("models", "\x1b[H", "\x1b[15~", "\x1bOP");
		expect(model.models).toBe("sonnet, gpt-5");

		// No apply from a rejected chunk.
		expect(host.applied).toHaveLength(0);
	});

	it("converts newlines and tabs to spaces in pasted text", () => {
		const { model, host, press } = driveConsole({ goal: "", breadth: 3 });

		// A pasted models list with an interior newline, a tab, and a trailing newline.
		press("models", "sonnet,\n\tgpt-5\n");
		expect(model.models).toBe("sonnet,  gpt-5 ");
		expect(model.setup().armModels).toEqual(["sonnet", "gpt-5"]);
		expect(host.applied.at(-1)?.armModels).toEqual(["sonnet", "gpt-5"]);

		press("goal", "make\n\tthe\tparser\nfast\n");
		expect(model.goal).toBe("make  the parser fast ");
		expect(model.setup().goal).toBe("make  the parser fast");
		expect(host.applied.at(-1)?.goal).toBe("make  the parser fast");
	});

	it("flattens a goal that arrived with a tab or a line break in it", () => {
		// A goal set by `/autoresearch goal` or a hand-edited session is one
		// row; a tab in it would open a hole through the value column.
		const { model } = driveConsole({ goal: "make\tit\n\nfast" });
		expect(model.goal).toBe("make it fast");
	});

	it("always lists the models row across all breadths", () => {
		for (let breadth = MIN_SWARM_BREADTH; breadth <= MAX_BREADTH; breadth += 1) {
			const { form } = driveConsole({ breadth });
			form.focus("models");
			expect(form.focusedId).toBe("models");
		}
	});

	it("calls host.apply with setup() on every field edit", () => {
		const { model, host, press } = driveConsole({
			goal: "fast",
			breadth: 3,
			attempts: 1,
			certify: true,
			maxIterations: null,
		});

		press("goal", "e", "r");
		expect(host.applied.at(-1)?.goal).toBe("faster");
		press("goal", BACKSPACE);
		expect(host.applied.at(-1)?.goal).toBe("faste");

		press("models", "sonnet, gpt-5");
		expect(host.applied.at(-1)?.armModels).toEqual(["sonnet", "gpt-5"]);
		press("models", BACKSPACE);
		expect(host.applied.at(-1)?.armModels).toEqual(["sonnet", "gpt-"]);

		press("breadth", RIGHT);
		expect(host.applied.at(-1)?.breadth).toBe(4);

		press("attempts", RIGHT);
		expect(host.applied.at(-1)?.attempts).toBe(2);

		press("certify", " ");
		expect(host.applied.at(-1)?.certify).toBe(false);

		press("iterations", "5", "0");
		expect(host.applied.at(-1)?.maxIterations).toBe(50);
		press("iterations", BACKSPACE);
		expect(host.applied.at(-1)?.maxIterations).toBe(5);
		expect(model.setup().maxIterations).toBe(5);
	});
});

/**
 * The `/mcp add` wizard is a ModalShell card that answers the pointer.
 *
 * WHAT THIS CLOSES. The wizard used to paint a bare `DynamicBorder` stack into
 * the composer slot and spell its keys out as bracketed hint lines in the body
 * ("[↑↓ to navigate, Enter to select, Esc to go back]"). It consumed no mouse
 * input: an option could not be clicked, a wheel notch did nothing, and there
 * was no close glyph because there was no card chrome to hold one. This suite
 * pins the contract the card now owes, the same one the other converted
 * pickers keep: hover bands the option under the pointer, a click takes that
 * option exactly as Enter does, a wheel notch steps the selection, and the
 * chrome cancels the wizard.
 *
 * It also pins the one thing this card does that the list pickers do not: the
 * footer chips are per STEP, not per surface. Esc cancels on the first step
 * and steps back on every later one, matching `handleInput`, and an input step
 * offers "enter continue" where an option step offers "enter select". A single
 * fixed chip row would lie on half the flow.
 *
 * WHAT IT DOES NOT CATCH. It drives the component directly, so it says nothing
 * about the host mounting it as a fullscreen overlay. It also does not reach
 * the "auth-method" or "oauth-error" steps: no transition in the wizard sets
 * them from a keystroke, so they are only reachable from a live connection
 * probe, which this suite does not run.
 *
 * Colour is forced ON: `theme.bg` returns its argument unchanged when colour
 * is off, so under the default piped policy a banded row is byte-identical to
 * a plain one and no assertion could tell them apart.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MCPAddWizard } from "@veyyon/coding-agent/modes/components/mcp-add-wizard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const BG_OPEN = /\x1b\[48;/;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	setAnsiPolicy(policy);
	geometry.restore();
});

/** SGR motion (button 32+3=35), left press, and wheel at 1-based screen coords. */
function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}
function clickAt(row1: number, col1 = 40): string {
	return `\x1b[<0;${col1};${row1}M`;
}
function wheelAt(direction: "up" | "down", row1: number, col1 = 40): string {
	return `\x1b[<${direction === "down" ? 65 : 64};${col1};${row1}M`;
}

interface Harness {
	wizard: MCPAddWizard;
	completed: Array<{ name: string; transport: string | undefined }>;
	cancelled: number;
	rows: () => string[];
	stripped: () => string[];
}

/**
 * A wizard at the step named by `initialName`: a name skips the text field and
 * opens on the transport list, `undefined` starts at the field. The parameter
 * has NO default on purpose — a default would swallow the explicit `undefined`
 * the input-step cases pass.
 */
function makeWizard(initialName: string | undefined): Harness {
	const harness: Harness = {
		wizard: undefined as unknown as MCPAddWizard,
		completed: [],
		cancelled: 0,
		rows: () => [],
		stripped: () => [],
	};
	harness.wizard = new MCPAddWizard(
		(name, config) => harness.completed.push({ name, transport: config.type }),
		() => {
			harness.cancelled += 1;
		},
		undefined,
		undefined,
		undefined,
		initialName,
	);
	harness.rows = () => [...harness.wizard.render(WIDTH)];
	harness.stripped = () => harness.rows().map(line => Bun.stripANSI(line));
	return harness;
}

/** 1-based screen row of the first rendered line containing `text`. */
function rowOf(harness: Harness, text: string): number {
	const index = harness.stripped().findIndex(line => line.includes(text));
	expect(index, `row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** 1-based row/col of the close glyph, from the frame the card last painted. */
function closeGlyph(harness: Harness): { row: number; col: number } {
	const lines = harness.stripped();
	const row = lines.findIndex(line => line.includes("[x]"));
	expect(row, "close glyph row").toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf("[x]") + 2 };
}

/**
 * 1-based row/col inside a footer chip. Chips are read from the STRIPPED frame:
 * the key and its label are styled separately, so the raw line never carries
 * the two words next to each other.
 */
function chip(harness: Harness, label: string): { row: number; col: number } {
	const lines = harness.stripped();
	const row = lines.findIndex(line => line.includes(label));
	expect(row, `footer row carrying ${JSON.stringify(label)}`).toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf(label) + 2 };
}

describe("the mcp add wizard card answers the pointer", () => {
	it("paints a titled card with a close glyph", () => {
		const frame = makeWizard("probe").stripped().join("\n");

		expect(frame).toContain("Add MCP Server");
		expect(frame).toContain("[x]");
		expect(frame).toContain("Step 2: Transport Type");
		// The bracketed hint lines are chips now, not body text.
		expect(frame).not.toContain("[↑↓ to navigate");
	});

	it("advertises the keys the step in front of you actually takes", () => {
		const optionStep = makeWizard("probe").stripped().join("\n");
		expect(optionStep).toContain("enter select");
		expect(optionStep).toContain("esc back");
		expect(optionStep).not.toContain("enter continue");

		const inputStep = makeWizard(undefined).stripped().join("\n");
		expect(inputStep).toContain("Step 1: Server Name");
		expect(inputStep).toContain("enter continue");
		// The first step has nothing behind it, so Esc abandons the wizard.
		expect(inputStep).toContain("esc cancel");
		expect(inputStep).not.toContain("esc back");
	});

	it("bands the option under the pointer without taking it", () => {
		const harness = makeWizard("probe");
		const row = rowOf(harness, "sse (Server-Sent Events)");
		const before = harness.rows()[row - 1] as string;

		harness.wizard.handleInput(motionAt(row));
		const after = harness.rows()[row - 1] as string;

		expect(after).not.toBe(before);
		expect(after).toMatch(BG_OPEN);
		expect(Bun.stripANSI(after)).toContain("sse (Server-Sent Events)");
		// Hover is not selection: the step did not advance.
		expect(harness.stripped().join("\n")).toContain("Step 2: Transport Type");
	});

	it("takes the option under a click, exactly as Enter does", () => {
		const harness = makeWizard("probe");

		harness.wizard.handleInput(clickAt(rowOf(harness, "http (HTTP server)")));

		const frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 3: Server URL");
		expect(frame).not.toContain("Step 2: Transport Type");
	});

	it("steps the selection on a wheel notch", () => {
		const harness = makeWizard("probe");
		// stdio is selected first; one notch down moves onto http, and Enter then
		// takes http rather than the transport the wizard opened on.
		harness.wizard.handleInput(wheelAt("down", rowOf(harness, "stdio (Local process)")));
		harness.wizard.handleInput("\n");

		expect(harness.stripped().join("\n")).toContain("Step 3: Server URL");
	});

	it("steps back on the esc chip and cancels on the chrome", () => {
		const back = makeWizard("probe");
		const backChip = chip(back, "esc back");
		back.wizard.handleInput(clickAt(backChip.row, backChip.col));

		expect(back.cancelled).toBe(0);
		expect(back.stripped().join("\n")).toContain("Step 1: Server Name");

		for (const target of ["glyph", "chip", "outside"] as const) {
			const harness = makeWizard(undefined);
			if (target === "glyph") {
				const glyph = closeGlyph(harness);
				harness.wizard.handleInput(clickAt(glyph.row, glyph.col));
			} else if (target === "chip") {
				const escapeChip = chip(harness, "esc cancel");
				harness.wizard.handleInput(clickAt(escapeChip.row, escapeChip.col));
			} else {
				// A card hit-tests against its LAST paint, so the frame has to exist
				// before a click can land outside it.
				harness.rows();
				harness.wizard.handleInput(clickAt(1, 1));
			}

			expect(harness.cancelled, target).toBe(1);
			expect(harness.completed, target).toEqual([]);
		}
	});

	it("cancels the whole wizard on the close glyph, not just the step", () => {
		const harness = makeWizard("probe");
		const glyph = closeGlyph(harness);

		harness.wizard.handleInput(clickAt(glyph.row, glyph.col));

		// The glyph closes the surface: it does NOT do what the `esc back` chip
		// does, which is the other thing a two-action card could plausibly mean.
		expect(harness.cancelled).toBe(1);
		expect(harness.stripped().join("\n")).toContain("Step 2: Transport Type");
	});

	it("keeps what you typed when the pointer moves over an input step", () => {
		const harness = makeWizard(undefined);
		for (const ch of "gateway") harness.wizard.handleInput(ch);
		expect(harness.stripped().join("\n")).toContain("gateway");

		// The body of an input step belongs to the text field. A wheel notch that
		// reached the option mover would re-run `#renderStep()`, which builds a
		// FRESH `Input` seeded from committed state, silently discarding the
		// half-typed name. A click on the prose must be inert for the same reason.
		const row = rowOf(harness, "Enter a unique name for this server:");
		harness.wizard.handleInput(wheelAt("down", row));
		harness.wizard.handleInput(clickAt(row));

		expect(harness.cancelled).toBe(0);
		const frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("gateway");
	});
});

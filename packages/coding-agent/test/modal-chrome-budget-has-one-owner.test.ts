/**
 * Every caller that sizes its own layout asks the shell how many body rows it
 * will get, instead of restating the arithmetic and losing content off the end.
 *
 * WHY THIS SUITE EXISTS. `render()` builds a body of `splitRows` split lines
 * plus ONE trailing strip row, and that strip row is the whole contextual
 * surface of the hub: the hint line that names every key, the role chip strip,
 * the thinking strip, the fallback-target strip, the new-role name input. The
 * body budget it sized the split against restated ModalShell's chrome
 * arithmetic as `3 + footerLines + vPad`, charging `vPad` ONCE where the shell
 * charges it twice, above AND below the body. The body therefore ran exactly
 * `vPad` rows long, the shell dropped its tail, and the strip row never
 * rendered at all on an ordinary 40-row terminal. Eleven assertions in
 * `model-hub.test.ts` failed on it and every one reported an empty `│ … │`
 * line, which named neither the strip nor the budget.
 *
 * `minModalChromeRows` is the one owner of those terms and exists precisely
 * because `ask-dialog.ts` made the identical mistake; the hub now calls it.
 *
 * Reclaiming the two rows made the roles pane genuinely shorter, which exposed
 * the second defect: the roles list drew from index 0 until it ran out of
 * budget and silently stopped. Rows past the cut vanished with no cue, and
 * arrowing onto one moved a cursor nobody could see. It now windows around the
 * selection, and mouse hit-testing shifts by the same offset.
 *
 * `session-selector.ts` carried the third copy of the same restatement, in the
 * other direction: it sized the card UP to fit its body with
 * `3 + vPad + max(footerLines, 1)`, so a long session list was handed an area
 * two-plus rows short and the shell dropped its tail. Same owner, same fix.
 */
import { beforeAll, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	computeModalDims,
	MODAL_SIZING_LARGE,
	minModalChromeRows,
	planModalChrome,
	renderModalShell,
	withCompact,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { ModelHubComponent } from "@veyyon/coding-agent/modes/components/model-hub";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/components/session-selector";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionInfo } from "@veyyon/coding-agent/session/session-listing";
import type { TUI } from "@veyyon/tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

function makeHub(options: { rows: number; settings?: Settings; models?: Model[] }): ModelHubComponent {
	const models = options.models ?? [makeModel("test", "model-a")];
	const registry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(), terminal: { rows: options.rows } } as unknown as TUI;
	return new ModelHubComponent(
		ui,
		options.settings ?? Settings.isolated({}),
		registry,
		models.map(model => ({ model })),
		{
			onAssign: vi.fn(),
			onUnassign: vi.fn(),
			onLoginRequest: vi.fn(),
			onFallbackChainChange: vi.fn(),
			onCancel: vi.fn(),
		},
	);
}

function plain(frame: readonly string[]): string[] {
	return frame.map(line => stripVTControlCharacters(line));
}

/** Every card row between the top and bottom borders, pad rows included. */
function cardRows(frame: readonly string[]): string[] {
	const lines = plain(frame);
	const top = lines.findIndex(line => line.trim().startsWith("┌"));
	const bottom = lines.findIndex(line => line.trim().startsWith("└"));
	if (top < 0 || bottom < 0) throw new Error("no card borders in frame");
	return lines.slice(top, bottom + 1);
}

/** Open the roles view: the sidebar starts on All models, one row below Roles. */
function enterRolesView(hub: ModelHubComponent): void {
	hub.handleInput(UP); // All models → Roles
	hub.handleInput("\n"); // dive into the rows
}

describe("the shell's chrome reservation has one owner", () => {
	/**
	 * The exact off-by-vPad that hid the strip row. `3 + footerLines + vPad` is
	 * the restatement the hub carried; it is two rows short of the truth, and
	 * this pins that they are not interchangeable so nobody "simplifies" the
	 * call back into an inline sum.
	 */
	test("minModalChromeRows charges vPad above AND below the body", () => {
		const sizing = MODAL_SIZING_LARGE;
		expect(sizing.vPad).toBe(2);
		expect(minModalChromeRows(sizing)).toBe(3 + sizing.footerLines + 2 * sizing.vPad);
		expect(minModalChromeRows(sizing)).toBe(3 + sizing.footerLines + sizing.vPad + 2);
	});

	/** The compact strip drops vPad entirely, so the two forms coincide there — which is why a short-terminal test would not have caught the bug. */
	test("the compact sizing collapses vPad, where both forms agree", () => {
		const compact = withCompact(MODAL_SIZING_LARGE, true);
		expect(compact.vPad).toBe(0);
		expect(minModalChromeRows(compact)).toBe(3 + compact.footerLines + compact.vPad);
	});
});

describe("no component restates the chrome arithmetic", () => {
	/**
	 * The guard, because this defect came back FIVE times.
	 *
	 * `model-hub` charged vPad once, `session-selector` charged vPad once,
	 * `extension-dashboard` subtracted a magic 8 against a real 9,
	 * `agent-dashboard` subtracted the same magic 8, and `model-picker`'s 8 was
	 * right only by the coincidence of an unnamed status row. Every one of them
	 * was written by someone reading the shell and copying the sum, and every one
	 * of them lost content off the end of a card with no error. The pattern is
	 * cheap to write and expensive to notice, so it is banned at the source rather
	 * than re-found by a person a sixth time.
	 *
	 * Scanning source is the only way to see it: nothing at runtime can observe
	 * that a correct number was computed the wrong way, and the number is correct
	 * right up until someone changes `vPad` or `footerLines`.
	 */
	const componentsDir = path.join(import.meta.dir, "..", "src", "modes", "components");
	const OWNER = path.join(componentsDir, "modal-shell.ts");

	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...sourceFiles(full));
			else if (entry.name.endsWith(".ts")) out.push(full);
		}
		return out;
	}

	/** Code lines only; this suite and the fixed sites both name the pattern in prose. */
	function isCode(line: string): boolean {
		const code = line.trim();
		return !(code.startsWith("//") || code.startsWith("*") || code.startsWith("/*"));
	}

	it("scans a meaningful number of component files, so a passing scan means something", () => {
		expect(sourceFiles(componentsDir).length).toBeGreaterThan(20);
	});

	/**
	 * A shrinking list of files not yet converted, NOT a place to park a new one.
	 *
	 * It is EMPTY, which is the goal state: the guard is unconditional and every
	 * component asks the shell. It stays in the code because a flat ban over
	 * pre-existing debt is switched off by the first person it blocks, so a future
	 * import that arrives with this pattern gets one honest place to record the
	 * debt instead of a reason to delete the guard. Adding an entry is a promise
	 * to remove it, not a way to make the failure go away.
	 */
	const CHROME_ARITHMETIC_BASELINE: readonly string[] = Object.freeze([]);

	it("subtracts no literal row count from a modal height", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(componentsDir)) {
			if (file === OWNER) continue;
			if (CHROME_ARITHMETIC_BASELINE.includes(path.basename(file))) continue;
			fs.readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (!isCode(line)) return;
					if (/\bmodalHeight\s*-\s*\d/.test(line)) {
						offenders.push(`${path.basename(file)}:${i + 1}`);
					}
				});
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The baseline is a debt record, so its contents are pinned rather than
	 * trusted. Empty means the guard currently binds every file; a diff that adds
	 * a name has to change this line too, which is the point.
	 */
	it("grandfathers nothing", () => {
		expect(CHROME_ARITHMETIC_BASELINE).toEqual([]);
		expect(Object.isFrozen(CHROME_ARITHMETIC_BASELINE)).toBe(true);
	});

	/** Every grandfathered file still exists, so the list cannot rot into a no-op. */
	it("names only files that are still there", () => {
		for (const name of CHROME_ARITHMETIC_BASELINE) {
			expect(fs.existsSync(path.join(componentsDir, name))).toBe(true);
		}
	});

	it("rebuilds no chrome sum out of vPad and footerLines", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(componentsDir)) {
			if (file === OWNER) continue;
			fs.readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (!isCode(line)) return;
					// `vPad` and `footerLines` appearing in the same expression is the
					// restatement; reading either alone (for a pad row, say) is fine.
					if (/vPad/.test(line) && /footerLines/.test(line)) {
						offenders.push(`${path.basename(file)}:${i + 1}`);
					}
				});
		}
		expect(offenders).toEqual([]);
	});

	it("finds the pattern it is meant to find", () => {
		// Anti-vacuity: the two forms that actually shipped must both match.
		expect(/\bmodalHeight\s*-\s*\d/.test("const rows = dims.modalHeight - 8 - preRows;")).toBe(true);
		expect(/\bmodalHeight\s*-\s*\d/.test("Math.max(1, this.#modalHeight - 8)")).toBe(true);
		const restated = "const chrome = 3 + sizing.vPad + Math.max(sizing.footerLines, 1);";
		expect(/vPad/.test(restated) && /footerLines/.test(restated)).toBe(true);
		// And the sanctioned call must not match either form.
		const sanctioned = "const chrome = planModalChrome({ sizing, modalHeight: dims.modalHeight, contentWidth });";
		expect(/\bmodalHeight\s*-\s*\d/.test(sanctioned)).toBe(false);
	});
});

describe("planModalChrome is the contract callers size against", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
	});

	const SHORTCUTS = [{ label: "enter pick" }, { label: "esc close" }];

	function renderBody(rows: number, bodyRows: number): string[] {
		const sizing = withCompact(MODAL_SIZING_LARGE, rows < 24);
		const dims = computeModalDims(200, rows, sizing);
		if (!dims) throw new Error("no dims");
		const body = Array.from({ length: bodyRows }, (_, i) => `BODY-${i}`);
		const shell = renderModalShell({
			title: "T",
			sizing,
			areaWidth: 200,
			areaHeight: rows,
			body,
			shortcuts: SHORTCUTS,
			showClose: true,
		});
		return plain(shell.lines);
	}

	function budgetFor(rows: number): number {
		const sizing = withCompact(MODAL_SIZING_LARGE, rows < 24);
		const dims = computeModalDims(200, rows, sizing);
		if (!dims) throw new Error("no dims");
		return planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts: SHORTCUTS,
		}).maxBodyRows;
	}

	/**
	 * The promise the number makes. Every caller that builds its own body relies
	 * on this exact equality, and all three that got it wrong were off by the
	 * same `vPad` the shell charges twice.
	 */
	test("a body of exactly maxBodyRows rows renders every row", () => {
		for (const rows of [24, 30, 40, 60]) {
			const budget = budgetFor(rows);
			const frame = renderBody(rows, budget).join("\n");
			expect(frame).toContain(`BODY-${budget - 1}`);
			expect(frame).toContain("BODY-0");
		}
	});

	/**
	 * And the failure mode, stated outright: one row over budget is DROPPED, with
	 * no error and no marker. That silence is why three callers shipped with
	 * content missing off the end.
	 */
	test("one row over budget is silently dropped from the end", () => {
		const rows = 40;
		const budget = budgetFor(rows);
		const frame = renderBody(rows, budget + 1).join("\n");
		expect(frame).toContain(`BODY-${budget - 1}`);
		expect(frame).not.toContain(`BODY-${budget}`);
	});

	/** The card never grows past what the terminal allows, whatever the body asks for. */
	test("an enormous body still fits the terminal exactly", () => {
		for (const rows of [24, 40, 60]) {
			const frame = renderBody(rows, 500);
			expect(frame.length).toBe(rows);
			expect(cardRows(frame).length).toBeLessThanOrEqual(rows);
		}
	});

	/** The plan never promises rows the card cannot hold. */
	test("maxBodyRows plus chrome equals the modal height it was planned for", () => {
		for (const rows of [24, 30, 40, 60]) {
			const sizing = withCompact(MODAL_SIZING_LARGE, rows < 24);
			const dims = computeModalDims(200, rows, sizing)!;
			const plan = planModalChrome({
				sizing,
				modalHeight: dims.modalHeight,
				contentWidth: dims.contentWidth,
				shortcuts: SHORTCUTS,
			});
			expect(plan.nonBody + plan.maxBodyRows).toBe(dims.modalHeight);
			expect(plan.maxBodyRows).toBeGreaterThan(0);
		}
	});
});

describe("ModelHub strip row", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
	});

	/**
	 * The regression itself, stated in the terms an operator would notice: the
	 * hint line that names every key in the hub was absent from the frame.
	 */
	test("the contextual hint line renders at a 40-row terminal", () => {
		const hub = makeHub({ rows: 40 });
		const frame = plain(hub.render(220)).join("\n");
		expect(frame).toContain("Enter assign roles");
		expect(frame).toContain("Esc close");
	});

	/**
	 * Not just at 40. The budget is height-dependent (the shell drops the tip,
	 * then vPad, as the card shrinks), so the strip has to survive the whole
	 * usable range rather than one lucky size.
	 */
	test("the hint line survives every terminal height from 16 to 60", () => {
		const missing: number[] = [];
		for (let rows = 16; rows <= 60; rows++) {
			const frame = plain(makeHub({ rows }).render(220)).join("\n");
			if (!frame.includes("Esc close")) missing.push(rows);
		}
		expect(missing).toEqual([]);
	});

	/**
	 * The structural half of the same claim: the card is the height the shell
	 * planned, so nothing was silently truncated to make the body fit.
	 */
	test("the card never exceeds the height the shell budgeted", () => {
		for (const rows of [24, 30, 40, 50]) {
			const frame = makeHub({ rows }).render(220);
			expect(frame.length).toBe(rows);
			expect(cardRows(frame).length).toBeLessThanOrEqual(rows);
		}
	});

	/**
	 * The strip is body content, distinct from ModalShell's own static shortcut
	 * chips below the divider. Both must be present: the earlier failure looked
	 * like "there is a footer" precisely because the chips still rendered while
	 * the strip did not.
	 */
	test("the strip row and the shell's shortcut chips are both present and different", () => {
		const lines = plain(makeHub({ rows: 40 }).render(220));
		const divider = lines.findIndex(line => line.trim().startsWith("├"));
		expect(divider).toBeGreaterThan(0);
		const strip = lines.slice(0, divider).find(line => line.includes("Enter assign roles"));
		const chips = lines.slice(divider).find(line => line.includes("esc close"));
		expect(strip).toBeDefined();
		expect(chips).toBeDefined();
		expect(strip).not.toBe(chips);
	});

	/** Opening a strip replaces the hint with the strip, in the same row. */
	test("an active strip takes the hint's place rather than a new row", () => {
		const hub = makeHub({ rows: 40 });
		const before = plain(hub.render(220));
		const hintRow = before.findIndex(line => line.includes("Enter assign roles"));
		expect(hintRow).toBeGreaterThan(0);

		hub.handleInput("\x1b[C"); // → focus the model list
		hub.handleInput("\n"); // Enter opens the role strip for the selected model
		const after = plain(hub.render(220));
		expect(after[hintRow]).toContain("model-a");
		expect(after[hintRow]).toContain("→");
		expect(after.join("\n")).not.toContain("Enter assign roles");
	});
});

describe("session picker card height", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
	});

	function makeSessions(count: number): SessionInfo[] {
		return Array.from({ length: count }, (_, i) => ({
			path: `s-${i}.jsonl`,
			id: `s-${i}`,
			cwd: "/repo",
			created: new Date(0),
			modified: new Date(1700000000000 + i * 1000),
			messageCount: 1,
			size: 100,
			firstMessage: `session number ${i}`,
			allMessagesText: `session number ${i}`,
		}));
	}

	function render(sessionCount: number, rows: number): string[] {
		const selector = new SessionSelectorComponent(
			makeSessions(sessionCount),
			() => {},
			() => {},
			() => {},
			{ getTerminalRows: () => rows, fillHeight: true },
		);
		return plain([...selector.render(120)]);
	}

	/**
	 * The picker sizes its card UP to fit the list, so an undercounted chrome
	 * reservation truncates the BOTTOM of the list rather than the chrome. The
	 * shell's own footer chips still drew, so it looked like a complete card
	 * with sessions missing from the end.
	 */
	test("a list that fits shows its last session and the footer chips", () => {
		const frame = render(3, 40).join("\n");
		expect(frame).toContain("session number 0");
		expect(frame).toContain("session number 2");
		expect(frame).toContain("esc close");
	});

	/** The card still stops at the terminal, and its borders are never sheared off. */
	test("a list taller than the terminal keeps both borders inside the frame", () => {
		const frame = render(200, 40);
		expect(frame.length).toBe(40);
		expect(frame.filter(line => line.trim().startsWith("┌")).length).toBe(1);
		expect(frame.filter(line => line.trim().startsWith("└")).length).toBe(1);
		expect(frame.join("\n")).toContain("esc close");
	});

	/**
	 * The card grows with the list rather than stretching to the terminal, which
	 * is the behavior the reservation exists to get right in the first place.
	 */
	test("the card grows with the list instead of filling the terminal", () => {
		const small = cardRows(render(2, 40)).length;
		const large = cardRows(render(20, 40)).length;
		expect(small).toBeLessThan(large);
		expect(large).toBeLessThanOrEqual(40);
	});
});

describe("ModelHub roles list windowing", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
	});

	function chainSettings(): Settings {
		return Settings.isolated({ "retry.fallbackChains": { "test/*": ["test/model-a"] } });
	}

	/**
	 * The rows that no longer fit are reachable, which is the whole point: before
	 * the window they were drawn only when they happened to fall inside the
	 * budget, and the cursor could sit on one that was not on screen.
	 */
	test("wrapping the selection to the last row scrolls it into view", () => {
		const hub = makeHub({ rows: 40, settings: chainSettings() });
		enterRolesView(hub);
		expect(plain(hub.render(220)).join("\n")).not.toContain("+ New fallback…");

		hub.handleInput(UP); // wraps past the end
		expect(plain(hub.render(220)).join("\n")).toContain("+ New fallback…");
	});

	/** Coming back to the top scrolls back, so the window is not one-way. */
	test("returning to the first row scrolls the window back to the start", () => {
		const hub = makeHub({ rows: 40, settings: chainSettings() });
		enterRolesView(hub);
		hub.handleInput(UP); // last row
		expect(plain(hub.render(220)).join("\n")).toContain("+ New fallback…");

		hub.handleInput(DOWN); // wraps back to the first role
		const frame = plain(hub.render(220)).join("\n");
		expect(frame).toContain("SMOL");
		expect(frame).not.toContain("+ New fallback…");
	});

	/**
	 * A window with no cue is the same defect wearing a different hat: the rows
	 * are gone and nothing on screen says so. The list borrows the TUI's one
	 * overflow idiom (`ScrollView` with `scrollbar: "auto"`, the same primitive
	 * the model browser composes rows inside) rather than inventing a second
	 * convention, so this asserts the actual glyphs rather than "something
	 * changed".
	 */
	test("an overflowing roles list draws the scrollbar track and thumb", () => {
		const hub = makeHub({ rows: 40, settings: chainSettings() });
		enterRolesView(hub);
		const frame = plain(hub.render(220)).join("\n");
		expect(frame).toContain("█"); // thumb
		expect(frame).toContain("│"); // track
	});

	/** And it is absent when everything fits, so the bar means what it says. */
	test("a list that fits draws no scrollbar", () => {
		const hub = makeHub({ rows: 60, settings: chainSettings() });
		enterRolesView(hub);
		const rolesPane = plain(hub.render(220))
			.filter(line => line.includes("SMOL") || line.includes("+ New fallback…"))
			.join("\n");
		expect(rolesPane).not.toContain("█");
	});

	/** The thumb tracks the window, so it is not painted at a fixed position. */
	test("the thumb moves when the window scrolls", () => {
		const hub = makeHub({ rows: 40, settings: chainSettings() });
		enterRolesView(hub);
		const thumbRows = (): number[] =>
			plain(hub.render(220))
				.map((line, i) => (line.includes("█") ? i : -1))
				.filter(i => i >= 0);
		const atTop = thumbRows();
		hub.handleInput(UP); // wrap to the last row, scrolling the window down
		const atBottom = thumbRows();
		expect(atTop.length).toBeGreaterThan(0);
		expect(atBottom.length).toBeGreaterThan(0);
		expect(atBottom[0]).toBeGreaterThan(atTop[0] as number);
	});

	/** A tall terminal has room for everything, so no window is applied at all. */
	test("a tall terminal shows the whole list with no scrolling", () => {
		const hub = makeHub({ rows: 60, settings: chainSettings() });
		enterRolesView(hub);
		const frame = plain(hub.render(220)).join("\n");
		expect(frame).toContain("SMOL");
		expect(frame).toContain("+ New role…");
		expect(frame).toContain("↳ test/model-a");
		expect(frame).toContain("+ New fallback…");
	});

	/**
	 * The selected row is always drawn. This is the invariant the window exists
	 * to hold, and it is asserted for every row rather than the two ends.
	 */
	test("every row in the list is on screen while it is selected", () => {
		const hub = makeHub({ rows: 40, settings: chainSettings() });
		enterRolesView(hub);
		const labels = [
			"SMOL",
			"SLOW",
			"VISION",
			"PLAN",
			"DESIGNER",
			"COMMIT",
			"TINY",
			"ADVISOR",
			"+ New role…",
			"test/*",
			"↳ test/model-a",
			"+ New fallback…",
		];
		const offScreen: string[] = [];
		for (const label of labels) {
			const frame = plain(hub.render(220));
			const row = frame.find(line => line.includes(label));
			// The cursor glyph marks the selected row; find it and confirm it is
			// the row we expect to be selected at this step.
			if (row === undefined || !row.includes("›")) offScreen.push(label);
			hub.handleInput(DOWN);
		}
		expect(offScreen).toEqual([]);
	});
});

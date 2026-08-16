import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentPauseGate } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { Settings } from "../../../config/settings";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { PauseScreenComponent, type PauseScreenHost, renderPauseScreen, runPauseScreen } from "../pause-screen";

// Strip SGR colors so assertions see visible text only.

interface FakeHost {
	host: PauseScreenHost;
	shown: Component[];
	statuses: string[];
	hiddenCount(): number;
}

function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const statuses: string[] = [];
	let hidden = 0;
	const host: PauseScreenHost = {
		ui: {
			showOverlay(component) {
				shown.push(component);
				return {
					hide: () => {
						hidden++;
					},
					setHidden() {},
					isHidden: () => false,
				};
			},
			setFocus() {},
			requestRender() {},
			terminal: { rows },
		},
		showStatus(message) {
			statuses.push(message);
		},
	};
	return { host, shown, statuses, hiddenCount: () => hidden };
}

describe("pause screen", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	describe("renderPauseScreen", () => {
		it("paints exactly the requested rows with title, explainer, clock, and hint", () => {
			const lines = renderPauseScreen(80, 24, 65_000);
			expect(lines.length).toBe(24);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("P A U S E D");
			expect(text).toContain("Main agent, subagents, and advisor");
			expect(text).toContain("paused for 1:05");
			// The hint names the click since the pointer resumes too (see the pointer suite below).
			expect(text).toContain("esc · enter · space · click — resume");
			// The pause bars are dithered ember fields, not flat blocks: two
			// burning panes separated by a gap.
			expect(text).toMatch(/[▒▓█]{2,}/);
		});

		it("drops to the compact card on small terminals", () => {
			const lines = renderPauseScreen(40, 10, 3_000);
			expect(lines.length).toBe(10);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("▌▌ P A U S E D");
			expect(text).toContain("paused for 0:03");
			expect(text).toContain("esc · click — resume");
			expect(text).not.toContain("█".repeat(5)); // no room for the big glyph
		});

		it("rolls the clock into hours past 60 minutes", () => {
			const text = renderPauseScreen(80, 24, 3_725_000).map(stripAnsi).join("\n");
			expect(text).toContain("paused for 1:02:05");
		});

		it("displays the session name when provided in full mode", () => {
			const lines = renderPauseScreen(80, 24, 65_000, "My Awesome Session");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("My Awesome Session");
			expect(text).toContain("P A U S E D");
		});

		it("displays the session name when provided in compact mode", () => {
			const lines = renderPauseScreen(40, 10, 3_000, "Compact Session Title");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("Compact Session Title");
			expect(text).toContain("▌▌ P A U S E D");
		});
	});

	describe("runPauseScreen", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			const { host, shown, statuses, hiddenCount } = makeHost();
			expect(agentPauseGate.paused).toBe(false);

			const run = runPauseScreen(host);
			await Bun.sleep(1);
			expect(agentPauseGate.paused).toBe(true);
			expect(shown.length).toBe(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x1b"); // escape → resume
			}
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x03"); // ctrl+c
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const { host, shown } = makeHost();
			await runPauseScreen(host); // must resolve immediately, not park
			expect(shown.length).toBe(0);
			expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
		});
	});

	/**
	 * WHY: the scene is a fullscreen overlay, so the TUI hands it the whole
	 * mouse-tracking set (1000h+1003h+1006h) and every report lands in
	 * `handleInput` as raw SGR bytes. Before this, the pointer did nothing on a
	 * screen whose only job is "get me out of here". The class closed: a
	 * resume affordance the hint names but the input path ignores, and its
	 * mirror, a report that is not a left press resuming by accident.
	 *
	 * Not caught: which pixel was clicked. The scene has no targets, so every
	 * coordinate is the same click, and the test does not pretend otherwise.
	 */
	describe("the pointer resumes the same way the keys do", () => {
		/** Let `runPauseScreen` reach its `await`, and let a resume settle, without a clock. */
		async function flush(): Promise<void> {
			for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		}

		async function open(): Promise<{ component: PauseScreenComponent; run: Promise<void>; hiddenCount(): number }> {
			const { host, shown, hiddenCount } = makeHost();
			const run = runPauseScreen(host);
			await flush();
			const component = shown[0];
			if (!(component instanceof PauseScreenComponent)) throw new Error("pause screen did not open");
			return { component, run, hiddenCount };
		}

		it("resumes on a left press anywhere on the scene", async () => {
			const { component, run, hiddenCount } = await open();
			expect(agentPauseGate.paused).toBe(true);

			component.handleInput("\x1b[<0;40;12M");
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
		});

		it("never resumes on a report that is not a left press", async () => {
			const { component, run, hiddenCount } = await open();

			// Every non-press form the overlay's tracking set can emit: motion,
			// left-drag, left release, wheel up/down, and the other buttons.
			for (const report of [
				"\x1b[<35;40;12M",
				"\x1b[<32;40;12M",
				"\x1b[<0;40;12m",
				"\x1b[<64;40;12M",
				"\x1b[<65;40;12M",
				"\x1b[<1;40;12M",
				"\x1b[<2;40;12M",
			]) {
				component.handleInput(report);
				await flush();
				expect(agentPauseGate.paused).toBe(true);
				expect(hiddenCount()).toBe(0);
			}

			component.handleInput("\x1b[<0;40;12M");
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("names the click in both the full scene and the compact card", () => {
			expect(stripAnsi(renderPauseScreen(80, 24, 1_000).join("\n"))).toContain("click — resume");
			expect(stripAnsi(renderPauseScreen(40, 10, 1_000).join("\n"))).toContain("click — resume");
		});
	});
});

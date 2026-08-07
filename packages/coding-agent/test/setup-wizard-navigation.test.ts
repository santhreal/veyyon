/**
 * Onboarding must be navigable with no prior knowledge of it.
 *
 * The report was "the onboarding is still hard to navigate and really bad", with
 * every navigation primitive already implemented, so what this suite pins is the
 * contract a first-time user reads off the screen rather than any one layout:
 *
 * 1. WHERE AM I. Every step renders its position and the names of the steps
 *    around it.
 * 2. HOW DO I GO BACK. Every step but the first says `← back`, and the first
 *    does not claim a step that does not exist.
 * 3. HOW DO I GET OUT. Every step says one key that ends the run, and it is
 *    still on screen at 80 columns. THE BUG: the footer was a single row, cut to
 *    width, and the wizard's own keys sit at the END of it, so `esc leave setup`
 *    was the first thing dropped on exactly the terminal where a user is most
 *    likely to be stuck. Six-hint steps (providers, subagents, import) all lost
 *    it at 80 columns.
 * 4. WHAT DOES ENTER DO. Every step names Enter.
 * 5. NOTHING IS CUT OFF at 80x24. THE BUGS: the approvals subtitle and both
 *    scenes' intro prose were 76 to 83 columns wide in a 72-column content
 *    column and ended in an ellipsis; the theme step's fixed ten-row preview ate
 *    the whole body budget, so the step whose only job is choosing a theme
 *    rendered ZERO theme rows; the glyph step went the same way once the footer
 *    took a second row.
 * 6. ESC MEANS WHAT THE SCREEN SAYS. THE BUG: the overlay consumed Esc for
 *    "leave setup" before the scene saw it, while the theme step printed "Esc
 *    returns to curated choices" and the sign-in panel had an abort-the-login
 *    branch keyed to Esc. Pressing the key the screen named ended onboarding
 *    from the deepest point in it. A scene now claims Esc through
 *    `escapeAction`, and the footer names whichever meaning is live.
 *
 * ISOLATION. Nothing here reads the operator's machine: settings are in-memory
 * and isolated, auth storage is a stub, and neither `shouldRun` (the subagent
 * and import scans, which walk the real home) is called. The subagent and import
 * lists are therefore empty, which is the honest trade: the layout contract is
 * what is under test, and no assertion depends on the operator's files.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AuthStorage } from "@veyyon/ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@veyyon/ai/oauth/types";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ALL_SCENES } from "@veyyon/coding-agent/modes/setup-wizard";
import { providersSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/providers";
import { themeSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/theme";
import type {
	SetupScene,
	SetupSceneController,
	SetupWizardContext,
} from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false, "unicode", false, "titanium", "light");
});

const SCENES = ALL_SCENES as readonly SetupScene[];
/** The steps of a full onboarding run, by the label the breadcrumb shows. */
const STEP_LABELS = SCENES.map(scene => scene.stepLabel ?? scene.title);

/**
 * A wizard context, plus a way to await the renders the scenes ask for.
 *
 * The two asynchronous steps here (loading every theme, starting an OAuth flow)
 * finish on real I/O, so the tests wait on the signal the code itself emits, a
 * `requestRender` call, rather than on a duration.
 */
function makeContext(rows: number, authStorage?: AuthStorage) {
	let waiters: Array<() => void> = [];
	const ctx = {
		settings: Settings.isolated(),
		session: {
			modelRegistry: {
				authStorage: authStorage ?? {
					hasAuth: () => false,
					has: () => false,
					getCredentialOrigin: () => undefined,
				},
				getAvailable: () => [],
				refresh: async () => {},
			},
		},
		openInBrowser: () => {},
		showError: () => {},
		ui: {
			terminal: { rows },
			setFocus: () => {},
			invalidate: () => {},
			requestRender: () => {
				for (const waiter of waiters) waiter();
				waiters = [];
			},
		},
	} as unknown as SetupWizardContext;
	/** Resolve once `settled()` holds, driven by the scene's own render requests. */
	const until = async (settled: () => boolean): Promise<void> => {
		while (!settled()) await new Promise<void>(resolve => waiters.push(resolve));
	};
	return { ctx, until };
}

/** A frame as trimmed plain-text rows, so assertions read like the screen does. */
function textRows(frame: readonly string[]): string[] {
	return frame.map(row => stripVTControlCharacters(row).trim());
}

/** The trailing run of non-blank rows: the footer, one row per hint line. */
function footerRows(frame: readonly string[]): string[] {
	const rows = textRows(frame);
	return rows.slice(rows.lastIndexOf("") + 1);
}

function frameText(frame: readonly string[]): string {
	return textRows(frame).join("\n");
}

/**
 * Drive a wizard to `index`, one `→` per step, and return the settled frame.
 *
 * Fake timers step the splash and the 420ms dissolve; `performance.now()` is
 * advanced with them, which is the clock the overlay's phases read.
 */
function frameAtStep(component: SetupWizardComponent, index: number, width: number): readonly string[] {
	vi.useFakeTimers();
	try {
		void component.run();
		component.handleInput("\r");
		vi.advanceTimersByTime(500);
		for (let step = 0; step < index; step++) {
			component.handleInput("\x1b[C");
			vi.advanceTimersByTime(500);
		}
		return component.render(width);
	} finally {
		vi.useRealTimers();
	}
}

describe("every onboarding step says where you are", () => {
	for (const [index, scene] of SCENES.entries()) {
		it(`${scene.id} renders its position and the steps around it`, () => {
			const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
			try {
				const text = frameText(frameAtStep(component, index, 80));
				expect(text).toContain(`${index + 1}/${SCENES.length}  ${STEP_LABELS.join(" › ")}`);
			} finally {
				component.dispose();
			}
		});
	}
});

describe("every onboarding step says how to leave it", () => {
	/**
	 * `←` is handled from the second step onward, and a capability the footer does
	 * not name does not exist as far as the user is concerned.
	 */
	for (const [index, scene] of SCENES.entries()) {
		it(`${scene.id} ${index === 0 ? "claims no step to go back to" : "offers ← back"}`, () => {
			const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
			try {
				const footer = footerRows(frameAtStep(component, index, 80)).join("  ");
				expect(footer.includes("← back")).toBe(index > 0);
			} finally {
				component.dispose();
			}
		});
	}

	/** `←` must actually walk back, not just be advertised. */
	it("goes back a step when ← is pressed, and the position follows", () => {
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		vi.useFakeTimers();
		try {
			void component.run();
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			component.handleInput("\x1b[C"); // step 2
			vi.advanceTimersByTime(500);
			expect(frameText(component.render(80))).toContain(`2/${SCENES.length}`);
			component.handleInput("\x1b[D"); // back to step 1
			vi.advanceTimersByTime(500);
			expect(frameText(component.render(80))).toContain(`1/${SCENES.length}`);
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	/**
	 * THE BUG this locks out: the footer was one row truncated to width, and the
	 * exit hint is last in the row, so at 80 columns the steps with six hints
	 * ended "…  esc le" and the way out was gone. Asserted per step because it
	 * only failed on the crowded ones.
	 */
	for (const [index, scene] of SCENES.entries()) {
		it(`${scene.id} still shows the way out at 80 columns`, () => {
			const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
			try {
				const footer = footerRows(frameAtStep(component, index, 80));
				expect(footer.join("  ")).toContain("esc leave setup");
				// A row may break only between hints, so none of them ends cut.
				for (const row of footer) expect(row.endsWith("…")).toBe(false);
			} finally {
				component.dispose();
			}
		});
	}

	/** Skipping a step and leaving setup are different acts and are named apart. */
	for (const [index, scene] of SCENES.entries()) {
		it(`${scene.id} names the skip key and what Enter does`, () => {
			const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
			try {
				const footer = footerRows(frameAtStep(component, index, 80)).join("  ");
				expect(footer).toContain(index === SCENES.length - 1 ? "→ skip" : "→ skip step");
				expect(footer).toContain("enter confirm");
			} finally {
				component.dispose();
			}
		});
	}
});

describe("nothing is cut off, at 80x24 or on a short terminal", () => {
	/**
	 * Swept across heights, not measured at one.
	 *
	 * 24 rows was the only height checked, and it is the one common height at
	 * which the approvals step's overflow was invisible: it was clean at 24 and
	 * 22 and broken at 20 and below, where two of its four rungs were off screen
	 * and unreachable however far you arrowed. A budget suite that samples a
	 * single viewport cannot see the failure it exists to catch.
	 */
	// 22 is the floor every scene is expected to clear. Below it the wizard's own
	// chrome (mark, step strip, title, subtitle, footer) leaves too little body
	// for any scene, which is a separate question from a scene that overflows a
	// budget it was handed; the approvals case below pins 20 on its own.
	for (const height of [22, 24]) {
		for (const [index, scene] of SCENES.entries()) {
			it(`${scene.id} fits its body budget at ${height} rows, so no row is hidden`, () => {
				const component = new SetupWizardComponent(makeContext(height).ctx, SCENES);
				try {
					const frame = frameAtStep(component, index, 80);
					expect(frame.length).toBe(height);
					expect(frameText(frame)).not.toContain("more row");
				} finally {
					component.dispose();
				}
			});
		}
	}
	/**
	 * The approvals step at 20 rows, on its own.
	 *
	 * It was the one scene that ignored the row budget the wizard hands every
	 * scene, so its list always emitted all four rungs and the overlay clipped
	 * the tail: at 20 rows the selected rung was off screen and stayed off screen
	 * however far you arrowed, so Enter committed a rung the operator could not
	 * see. It now sizes the list to the budget and drops its intro prose before
	 * it drops a rung. Pinned at the height where that showed, since the sweep
	 * above starts at 22.
	 */
	it("approvals fits its rungs into a 20-row terminal instead of being clipped", () => {
		const index = SCENES.findIndex(scene => scene.id === "approvals");
		const component = new SetupWizardComponent(makeContext(20).ctx, SCENES);
		try {
			const text = frameText(frameAtStep(component, index, 80));
			// Nothing is clipped away by the overlay: the scene fits what it was
			// given instead of overrunning and being cut.
			expect(text).not.toContain("more row");
			// And the choice is on screen. At this height the intro prose yields so
			// the rungs can render; the row Enter would take is always visible.
			expect(text).toContain("Auto (current)");
			// The list scrolled to the cursor rather than rendering from the top and
			// letting the overlay cut the rest, which is what put the selected rung
			// off screen before.
			expect(text).toContain("Runs; boundary checks still ask");
		} finally {
			component.dispose();
		}
	});

	/**
	 * A scene's own intro prose was written as one long row per sentence and cut
	 * by the frame: the subagents step ended "Change it later in Settings →
	 * Suba…", so the place to change the answer was named and then hidden, and
	 * the approvals step lost the end of the sentence that groups the tools.
	 */
	it("wraps a scene's intro prose rather than cutting the end off it", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["subagents", "Settings → Subagents."],
			["approvals", "and running commands."],
		];
		for (const [id, tail] of cases) {
			const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
			try {
				// Joined with a space: the sentence is wrapped now, so it spans rows.
				const flowed = textRows(
					frameAtStep(
						component,
						SCENES.findIndex(scene => scene.id === id),
						80,
					),
				).join(" ");
				expect(flowed).toContain(tail);
			} finally {
				component.dispose();
			}
		}
	});

	/**
	 * The approvals subtitle is 76 columns of prose in a 72-column content column
	 * and used to end "…for one session with /permissi…", losing the name of the
	 * command it was telling the user about.
	 */
	it("wraps a subtitle too long for the content column instead of cutting it", () => {
		const index = SCENES.findIndex(scene => scene.id === "approvals");
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		try {
			const text = frameText(frameAtStep(component, index, 80));
			expect(text).toContain("/permissions.");
			expect(text).not.toContain("/permissi…");
		} finally {
			component.dispose();
		}
	});

	/**
	 * `SelectList` cuts a description that overruns its column with no ellipsis,
	 * and that column is about 38 columns at every terminal size, so the approvals
	 * rungs read as fragments ("Every tool call asks first, reads in") even on a
	 * 120-column terminal: the step that decides what the agent may do to the
	 * machine described none of its four answers completely.
	 */
	it("states each approval rung completely, and marks the one Enter would keep", () => {
		const index = SCENES.findIndex(scene => scene.id === "approvals");
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		try {
			const text = frameText(frameAtStep(component, index, 80));
			for (const description of [
				"Asks first for every tool call",
				"Asks before running a command",
				"Runs; boundary checks still ask",
				"Only destructive commands ask",
			]) {
				expect(text).toContain(description);
			}
			// And the yolo row does not claim a guard that exists does not. The
			// critical floor survives that rung, so "not even rm -rf /" was false
			// on the one sentence a first-time user reads to decide.
			expect(text).not.toContain("not even rm -rf /");
			// Enter keeps what is already in force, and the row says which that is.
			expect(text).toContain("(current)");
		} finally {
			component.dispose();
		}
	});

	/**
	 * THE BUG: `SelectList` prints its own key legend beside the search row, and
	 * it ends "esc close". Inside the wizard Esc does not close a list, it leaves
	 * setup, so the web-search panel showed two different meanings for one key in
	 * the same frame, one of them in the footer and one four rows above it. The
	 * wizard footer is the authority, so the panel's list drops its legend, as the
	 * other searchable wizard lists already do.
	 */
	it("keeps the web-search panel inside the viewport and names no key the footer denies", () => {
		const index = SCENES.findIndex(scene => scene.id === "providers");
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		try {
			frameAtStep(component, index, 100);
			component.handleInput("\t"); // to the "Web search" panel
			const text = frameText(component.render(100));
			// The panel asked for eight list rows on any terminal and overran a
			// 24-row one by eight, taking the readiness line off-screen with it.
			expect(text).not.toContain("more row");
			expect(text).toContain("Type to search");
			expect(text).not.toContain("esc close");
			expect(text).not.toContain("esc clear");
		} finally {
			component.dispose();
		}
	});

	/**
	 * THE BUG: the theme preview was a fixed ten rows and the body budget at
	 * 80x24 is nine, so the overflow notice took the last row and the theme list
	 * rendered nothing at all. "Browse all…" is the row that reaches every other
	 * theme, so its absence is the difference between a usable step and a dead
	 * end.
	 */
	it("keeps every curated theme row reachable at 80x24, trimming the preview instead", () => {
		const index = SCENES.findIndex(scene => scene.id === "theme");
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		try {
			const text = frameText(frameAtStep(component, index, 80));
			for (const row of ["Match terminal", "Titanium", "Light", "Browse all…"]) {
				expect(text).toContain(row);
			}
			// The swatch survives: it is the part that changes with the highlight.
			expect(text).toContain("Preview");
		} finally {
			component.dispose();
		}
	});

	/** Same failure on the glyph step: three presets to compare, one rendered. */
	it("keeps all three glyph presets on screen at 80x24", () => {
		const index = SCENES.findIndex(scene => scene.id === "glyph-mode");
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		try {
			const text = frameText(frameAtStep(component, index, 80));
			for (const row of ["Nerd Font", "Unicode", "ASCII"]) expect(text).toContain(row);
		} finally {
			component.dispose();
		}
	});

	/** A tall terminal must still get the full preview: trimming is for tight rows. */
	it("restores the full theme preview when the rows are there", () => {
		const index = SCENES.findIndex(scene => scene.id === "theme");
		const component = new SetupWizardComponent(makeContext(40).ctx, SCENES);
		try {
			const text = frameText(frameAtStep(component, index, 120));
			expect(text).toContain("Status line");
			expect(text).toContain("Editor");
		} finally {
			component.dispose();
		}
	});
});

describe("Esc means what the frame says it means", () => {
	function claimingScene(id: string, label: string): { scene: SetupScene; received: string[] } {
		const received: string[] = [];
		const scene: SetupScene = {
			id,
			title: id,
			stepLabel: id,
			minVersion: 1,
			mount: (): SetupSceneController => ({
				title: id,
				render: () => ["body"],
				invalidate: () => {},
				handleInput: (data: string) => received.push(data),
				escapeAction: () => ({ keys: "esc", label }),
			}),
		};
		return { scene, received };
	}

	/**
	 * THE BUG: the overlay took Esc unconditionally, so a scene in a sub-state
	 * could not be backed out of and the key the scene advertised ended the whole
	 * run instead. A claiming scene now receives the keystroke.
	 */
	it("hands Esc to a scene that claims it, and does not end the run", async () => {
		const { scene, received } = claimingScene("claims", "back to list");
		const component = new SetupWizardComponent(makeContext(24).ctx, [scene]);
		vi.useFakeTimers();
		try {
			let settled = false;
			void component.run().then(() => {
				settled = true;
			});
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			component.handleInput("\x1b");
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			expect(received).toEqual(["\x1b"]);
			expect(settled).toBe(false);
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	/**
	 * The footer must name the meaning that is live, and must still name a key
	 * that ends the run: ctrl+c does (gracefully, through the outro), so it takes
	 * the exit slot while the scene owns Esc.
	 */
	it("names the scene's meaning for Esc, and ctrl+c as the exit, while the claim stands", () => {
		const { scene } = claimingScene("claims", "back to list");
		const component = new SetupWizardComponent(makeContext(24).ctx, [scene]);
		try {
			const footer = footerRows(frameAtStep(component, 0, 80)).join("  ");
			expect(footer).toContain("esc back to list");
			expect(footer).toContain("ctrl+c leave setup");
			expect(footer).not.toContain("esc leave setup");
		} finally {
			component.dispose();
		}
	});

	/** A scene that claims nothing must not have Esc stolen from the wizard. */
	it("still leaves setup from a scene that claims nothing", async () => {
		const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
		vi.useFakeTimers();
		try {
			let settled = false;
			void component.run().then(() => {
				settled = true;
			});
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			component.handleInput("\x1b");
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			expect(settled).toBe(true);
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	/**
	 * The theme step's own copy, on screen since browsing was added: "Esc returns
	 * to curated choices". It was false. Esc ended onboarding from the one place a
	 * user is furthest into it, having just opened a list of every theme.
	 */
	it("returns the theme step from browsing all themes to the curated rows", async () => {
		const { ctx, until } = makeContext(40);
		const component = new SetupWizardComponent(ctx, [themeSetupScene]);
		try {
			// The dissolve into the first scene is timer-driven; everything after it
			// is driven by the scene's own render requests.
			vi.useFakeTimers();
			void component.run();
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			vi.useRealTimers();
			// Walk to "Browse all…" by watching the cursor rather than counting
			// rows: the list opens on whichever theme is already in force.
			for (let i = 0; i < 8 && !textRows(component.render(100)).some(row => row.startsWith("› Browse all…")); i++) {
				component.handleInput("\x1b[B");
			}
			expect(textRows(component.render(100)).some(row => row.startsWith("› Browse all…"))).toBe(true);
			component.handleInput("\r");
			await until(() => frameText(component.render(100)).includes("Browsing all themes"));
			const browsing = component.render(100);
			expect(frameText(browsing)).toContain("Browsing all themes · Esc returns to curated choices");
			expect(footerRows(browsing).join("  ")).toContain("esc back to curated");

			component.handleInput("\x1b");
			const curated = component.render(100);
			expect(frameText(curated)).not.toContain("Browsing all themes");
			expect(frameText(curated)).toContain("Browse all…");
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	/**
	 * THE BUG: the sign-in panel aborts an in-flight OAuth login on Esc, and that
	 * branch could never run, because the overlay ended onboarding first. A
	 * browser flow that never came back could only be escaped by abandoning
	 * setup.
	 */
	it("aborts an in-flight login instead of ending the run", async () => {
		const loginGate = Promise.withResolvers<void>();
		const loginStarted = Promise.withResolvers<AbortSignal>();
		const authStorage = {
			has: () => false,
			hasAuth: () => false,
			getCredentialOrigin: () => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url: "https://example.com/oauth/authorize?state=abort" });
				loginStarted.resolve(ctrl.signal);
				// Never returns on its own: this is the "browser flow that did not
				// come back" the user has to be able to escape from.
				await loginGate.promise;
			},
		} as unknown as AuthStorage;
		const component = new SetupWizardComponent(makeContext(40, authStorage).ctx, [providersSetupScene]);
		try {
			let settled = false;
			vi.useFakeTimers();
			void component.run().then(() => {
				settled = true;
			});
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			vi.useRealTimers();
			for (const char of "anthropic") component.handleInput(char);
			component.handleInput("\r");
			const signal = await loginStarted.promise;
			expect(footerRows(component.render(100)).join("  ")).toContain("esc cancel sign-in");

			component.handleInput("\x1b");
			expect(signal.aborted).toBe(true);
			expect(settled).toBe(false);
		} finally {
			vi.useRealTimers();
			loginGate.resolve();
			component.dispose();
		}
	});

	/**
	 * THE NAVIGATION KILLER.
	 *
	 * Every list in setup turns into a type-to-filter list once it holds more
	 * rows than the terminal leaves it, which an 80x24 terminal does on two
	 * steps. Both of those lists consume Esc to clear their filter. Neither
	 * CLAIMED it, so the wizard took Esc first and ENDED ONBOARDING: type one
	 * letter to find a provider, press Esc to undo the typo, and the run is over.
	 * On step 1, the first thing a new user touches.
	 *
	 * The sign-in panel was worse than the theme step. `OAuthSelectorComponent`
	 * had no cancel ladder at all, so even reaching it, Esc went straight to its
	 * cancel callback: no clear, no recovery, and the footer still reading "esc
	 * leave setup" the whole time.
	 *
	 * WHAT IS PINNED, on rendered strings, at 80x24, for both surfaces: the
	 * search row shows the typed query, the footer stops claiming Esc leaves
	 * setup and names what Esc really does, Esc clears the query, the run is
	 * STILL RUNNING afterwards, and a second Esc with no query still leaves,
	 * because that is the exit everyone relies on.
	 */
	const searchableSteps: ReadonlyArray<readonly [string, string]> = [
		// Step 1's panel: OAuthSelectorComponent, ~30 providers.
		["providers", "Search: i"],
		// The curated theme rows, searchable as soon as the budget drops below six.
		["theme", "Search: i"],
	];

	for (const [id, searchRow] of searchableSteps) {
		it(`${id} clears a typed filter with Esc and stays in setup`, async () => {
			const index = SCENES.findIndex(scene => scene.id === id);
			const component = new SetupWizardComponent(makeContext(24).ctx, SCENES);
			vi.useFakeTimers();
			try {
				let settled = false;
				const done = component.run().then(() => {
					settled = true;
				});
				component.handleInput("\r");
				vi.advanceTimersByTime(500);
				for (let step = 0; step < index; step++) {
					component.handleInput("\x1b[C");
					vi.advanceTimersByTime(500);
				}
				// The list sizes itself against the row budget it is handed at
				// render time, which is what makes it searchable at this height.
				component.render(80);

				component.handleInput("i");
				const filtered = frameText(component.render(80));
				expect(filtered).toContain(searchRow);
				expect(filtered).toContain("esc clear search");
				expect(filtered).not.toContain("esc leave setup");
				// The exit is still named, on the key that still performs it.
				expect(filtered).toContain("ctrl+c leave setup");

				component.handleInput("\x1b");
				vi.advanceTimersByTime(500);
				const cleared = frameText(component.render(80));
				expect(settled).toBe(false);
				expect(cleared).not.toContain(searchRow);
				expect(cleared).toContain("Type to search");
				// Back to the wizard's Esc, advertised again now that it is live.
				expect(cleared).toContain("esc leave setup");
				expect(cleared).not.toContain("esc clear search");
				// And the step itself is still on screen, not an outro.
				expect(cleared).toContain(STEP_LABELS[index] ?? "");

				// Second Esc, no query: the run ends, which is the behaviour the
				// claim must not have cost.
				component.handleInput("\x1b");
				vi.advanceTimersByTime(5000);
				await done;
				expect(settled).toBe(true);
			} finally {
				vi.useRealTimers();
				component.dispose();
			}
		});
	}
});

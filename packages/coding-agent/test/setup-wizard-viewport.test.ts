/**
 * Onboarding must let you SEE all of a step, and LEAVE it.
 *
 * THE BUGS THIS SUITE LOCKS OUT. Three separate reports, one root cause each:
 *
 * 1. "You can't see all of it." The overlay applied its body budget as a bare
 *    `slice`, and no scene knew the budget existed, so every list asked for a
 *    fixed number of rows and the tail was cut with nothing on screen to say so.
 *    On the curated theme list the row that vanished was "Browse all…", the only
 *    route to every other theme; on the provider list it was whichever providers
 *    fell past the fold. The wizard now hands each scene its row budget, and any
 *    residual overrun is announced instead of dropped.
 *
 * 2. "Hard to skip." Esc fell through to the active scene, where no scene
 *    claimed it, and the single advertised exit was ctrl+c — a key users read as
 *    "kill the program". Esc now leaves setup from any scene.
 *
 * 3. "Controls make no sense." `→` runs `#finishScene`, which advances the step
 *    and commits nothing: it is a skip, and the footer called it "next" right
 *    beside "enter confirm", so nothing on screen distinguished keeping a choice
 *    from abandoning it. The footer labels are pinned in `setup-wizard.test.ts`;
 *    what is pinned HERE is that the keys behave as labelled.
 *
 * WHAT IS PINNED. The budget arithmetic (a scene is offered exactly the rows
 * left after header and footer), the overflow notice and its count, that a scene
 * inside its budget is left untouched, that Esc ends the run from a scene, and
 * that each REAL scene fits the viewport it is given — the last being the
 * regression that made onboarding content unreachable in the first place.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { agentsSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/agents";
import { importSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";
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
	await initTheme(false);
});

/**
 * A single-scene run's header is 10 rows (blank, five sun rows, the wordmark,
 * blank, the title, blank) and its footer is 2, so a 30-row viewport leaves 18.
 * A single-scene run shows no progress row, which is why this is 18 and not 16.
 */
const BODY_ROWS_AT_30 = 18;

function hasRow(frame: readonly string[], text: string): boolean {
	return frame.some(row => row.replace(/\x1b\[[0-9;]*m/g, "").includes(text));
}

function makeContext(rows: number): SetupWizardContext {
	return {
		settings: Settings.isolated(),
		// The providers scene reads auth state to mark connected accounts. Nothing
		// is signed in, and the test must never touch the real machine's keys.
		session: {
			modelRegistry: {
				authStorage: { hasAuth: () => false, has: () => false, getCredentialOrigin: () => undefined },
				getAvailable: () => [],
			},
		},
		openInBrowser: () => {},
		showError: () => {},
		ui: { terminal: { rows }, setFocus: () => {}, requestRender: () => {}, invalidate: () => {} },
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as SetupWizardContext;
}

/**
 * A scene that records the row budget it was handed and emits `bodyRows` rows,
 * so the overlay's arithmetic and clipping can be observed directly instead of
 * inferred from a real scene's layout.
 */
function probeScene(bodyRows: number, seen: { rows?: number } = {}): SetupScene {
	return {
		id: "probe",
		title: "Probe",
		minVersion: 1,
		mount: (): SetupSceneController => ({
			title: "Probe",
			render: (_width: number, rows?: number) => {
				seen.rows = rows;
				return Array.from({ length: bodyRows }, (_, index) => `body ${index + 1}`);
			},
			invalidate: () => {},
		}),
	};
}

/** Drive the overlay to its settled scene phase and return the frame. */
function sceneFrame(component: SetupWizardComponent, width: number): readonly string[] {
	vi.useFakeTimers();
	try {
		void component.run();
		component.handleInput("\r"); // leave the splash
		vi.advanceTimersByTime(500); // let the 420ms dissolve settle
		return component.render(width);
	} finally {
		vi.useRealTimers();
	}
}

describe("the wizard hands each scene its row budget", () => {
	/**
	 * The budget is the whole point: a scene cannot size a list to the viewport
	 * without being told how much of it is left. Pinned as an exact number so a
	 * header or footer row added later cannot silently shrink what scenes are
	 * promised while every scene keeps sizing against the old figure.
	 */
	it("offers exactly the rows left after the header and the footer", () => {
		const seen: { rows?: number } = {};
		const component = new SetupWizardComponent(makeContext(30), [probeScene(1, seen)]);
		try {
			const frame = sceneFrame(component, 100);
			expect(frame.length).toBe(30);
			expect(seen.rows).toBe(BODY_ROWS_AT_30);
		} finally {
			component.dispose();
		}
	});

	/** A shorter terminal must shrink the promise, not the truth about it: the
	 *  budget tracks the viewport one row for one row. */
	it("shrinks the budget with the viewport", () => {
		const tall: { rows?: number } = {};
		const short: { rows?: number } = {};
		const tallComponent = new SetupWizardComponent(makeContext(40), [probeScene(1, tall)]);
		const shortComponent = new SetupWizardComponent(makeContext(20), [probeScene(1, short)]);
		try {
			sceneFrame(tallComponent, 100);
			sceneFrame(shortComponent, 100);
			expect(tall.rows).toBe(BODY_ROWS_AT_30 + 10);
			expect(short.rows).toBe(BODY_ROWS_AT_30 - 10);
		} finally {
			tallComponent.dispose();
			shortComponent.dispose();
		}
	});
});

describe("an overrun is announced, never silently cut", () => {
	/**
	 * The exact failure users reported: rows past the budget simply stopped
	 * existing. The last row of the body is now a count, so an overrun is
	 * visible. The count includes the row the notice displaced, because that row
	 * is hidden too.
	 */
	it("replaces the last row with a count of everything hidden", () => {
		const seen: { rows?: number } = {};
		const component = new SetupWizardComponent(makeContext(30), [probeScene(25, seen)]);
		try {
			const frame = sceneFrame(component, 100);
			expect(seen.rows).toBe(BODY_ROWS_AT_30);
			// 25 rows into 18: 17 survive, and the 18th states the 8 that do not.
			expect(hasRow(frame, "body 17")).toBe(true);
			expect(hasRow(frame, "body 18")).toBe(false);
			expect(hasRow(frame, "↓ 8 more rows below")).toBe(true);
		} finally {
			component.dispose();
		}
	});

	/** The smallest overrun is the easiest to get wrong by one: 19 rows into an
	 *  18-row budget hides the 18th and the 19th, so the count is 2, not 1. */
	it("counts the smallest overrun correctly and stays silent at the boundary", () => {
		const over = new SetupWizardComponent(makeContext(30), [probeScene(BODY_ROWS_AT_30 + 1)]);
		const exact = new SetupWizardComponent(makeContext(30), [probeScene(BODY_ROWS_AT_30)]);
		try {
			expect(hasRow(sceneFrame(over, 100), "↓ 2 more rows below")).toBe(true);
			// Exactly at the budget: nothing is hidden, so nothing is announced.
			expect(hasRow(sceneFrame(exact, 100), "more row")).toBe(false);
		} finally {
			over.dispose();
			exact.dispose();
		}
	});

	/** A scene inside its budget must pass through untouched: the notice is for
	 *  real overruns, and a false one would cost a row of real content. */
	it("leaves a scene that fits completely alone", () => {
		const component = new SetupWizardComponent(makeContext(30), [probeScene(3)]);
		try {
			const frame = sceneFrame(component, 100);
			expect(hasRow(frame, "body 1")).toBe(true);
			expect(hasRow(frame, "body 2")).toBe(true);
			expect(hasRow(frame, "body 3")).toBe(true);
			expect(hasRow(frame, "more row")).toBe(false);
		} finally {
			component.dispose();
		}
	});
});

describe("Esc leaves setup", () => {
	/**
	 * Esc used to fall through to the scene, which never claimed it, so the run
	 * could only be ended with ctrl+c. Asserted on the run promise, because the
	 * observable contract is that onboarding ENDS, not that a field moved.
	 */
	it("ends the run from inside a scene", async () => {
		const component = new SetupWizardComponent(makeContext(30), [probeScene(1), probeScene(1)]);
		vi.useFakeTimers();
		try {
			let settled = false;
			const done = component.run().then(() => {
				settled = true;
			});
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			expect(settled).toBe(false);
			component.handleInput("\x1b"); // Esc
			// The outro plays before the run resolves; let its timer elapse.
			vi.advanceTimersByTime(5000);
			await done;
			expect(settled).toBe(true);
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	/** Esc must not reach a scene that handles keys itself, which is every real
	 *  scene: they all forward unrecognised input to a list, where Esc means
	 *  something else entirely (clear the filter, or close the list). */
	it("is not delivered to the active scene", () => {
		const received: string[] = [];
		const scene: SetupScene = {
			id: "greedy",
			title: "Greedy",
			minVersion: 1,
			mount: (): SetupSceneController => ({
				title: "Greedy",
				render: () => ["body"],
				invalidate: () => {},
				handleInput: (data: string) => received.push(data),
			}),
		};
		const component = new SetupWizardComponent(makeContext(30), [scene]);
		vi.useFakeTimers();
		try {
			void component.run();
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			component.handleInput("\x1b");
			expect(received).toEqual([]);
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});
});

describe("the progress breadcrumb names the steps", () => {
	function labelled(id: string, stepLabel: string): SetupScene {
		return {
			id,
			title: `${stepLabel} title`,
			stepLabel,
			minVersion: 1,
			mount: (): SetupSceneController => ({
				title: `${stepLabel} title`,
				render: () => ["body"],
				invalidate: () => {},
			}),
		};
	}

	/**
	 * It used to read `█ ▓ · · ·   step 3 of 5`: five marks in a private glyph
	 * vocabulary, so the only readable part was the count and nothing said what
	 * onboarding would ask next. Naming every step is how a user can tell whether
	 * the thing they came to configure is still ahead of them.
	 */
	it("shows every step name in order, with the position", () => {
		const component = new SetupWizardComponent(makeContext(30), [
			labelled("a", "Providers"),
			labelled("b", "Subagents"),
			labelled("c", "Theme"),
		]);
		try {
			const frame = sceneFrame(component, 100);
			expect(hasRow(frame, "1/3  Providers › Subagents › Theme")).toBe(true);
		} finally {
			component.dispose();
		}
	});

	/** A single-step run has no progress to show: one lone name reads as a stray
	 *  label rather than a position in a sequence. */
	it("stays empty for a single-step run", () => {
		const component = new SetupWizardComponent(makeContext(30), [labelled("a", "Providers")]);
		try {
			expect(hasRow(sceneFrame(component, 100), "Providers ›")).toBe(false);
			expect(hasRow(sceneFrame(component, 100), "1/1")).toBe(false);
		} finally {
			component.dispose();
		}
	});

	/**
	 * A breadcrumb cut mid-word is worse than a count, so a terminal too narrow to
	 * hold the names gets the count instead. Without this the names would be
	 * truncated by the frame and the row would end inside a step's label.
	 */
	it("falls back to a plain count when the names cannot fit", () => {
		const component = new SetupWizardComponent(makeContext(30), [
			labelled("a", "Providers"),
			labelled("b", "Subagents"),
			labelled("c", "Glyphs"),
			labelled("d", "Theme"),
			labelled("e", "Import"),
		]);
		try {
			const narrow = sceneFrame(component, 34);
			expect(hasRow(narrow, "step 1 of 5")).toBe(true);
			expect(hasRow(narrow, "Subagents")).toBe(false);
		} finally {
			component.dispose();
		}
	});

	/** The shipped scenes must all carry a short label, or the breadcrumb falls
	 *  back to sentence-length titles and immediately overflows. */
	it("every shipped scene declares a short step label", () => {
		for (const scene of [providersSetupScene, agentsSetupScene, themeSetupScene, importSetupScene]) {
			expect(scene.stepLabel).toBeDefined();
			expect((scene.stepLabel ?? "").length).toBeLessThanOrEqual(12);
		}
	});
});

describe("every real scene fits the viewport it is given", () => {
	const scenes: ReadonlyArray<readonly [string, SetupScene]> = [
		["providers", providersSetupScene],
		["subagents", agentsSetupScene],
		["theme", themeSetupScene],
		["import", importSetupScene],
	];

	/**
	 * The regression that made onboarding content unreachable. Each shipped scene
	 * is mounted for real and must render inside its budget, so none of them needs
	 * the overflow notice at an ordinary terminal size. A scene that regresses
	 * here is a scene whose tail a user cannot reach — and the tail is where
	 * "Browse all…" and the last providers live.
	 */
	for (const [name, scene] of scenes) {
		it(`${name} needs no overflow notice at 100x30`, async () => {
			const ctx = makeContext(30);
			// Scenes that discover their own rows fill them in `shouldRun`.
			await scene.shouldRun?.(ctx);
			const component = new SetupWizardComponent(ctx, [scene]);
			try {
				expect(hasRow(sceneFrame(component, 100), "more row")).toBe(false);
			} finally {
				component.dispose();
			}
		});
	}
});

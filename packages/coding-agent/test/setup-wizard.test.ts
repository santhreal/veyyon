import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { runOnboardingSetup } from "@veyyon/coding-agent/commands/setup";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import * as realImportScan from "@veyyon/coding-agent/discovery/import-scan";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	markSetupWizardComplete,
	runSetupWizard,
	type SetupScene,
	type SetupSceneController,
	type SetupSceneHost,
	selectSetupScenes,
} from "@veyyon/coding-agent/modes/setup-wizard";
import { providersSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/providers";
import { themeSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/theme";
import type { SetupKeyHint } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { WebSearchTab } from "@veyyon/coding-agent/modes/setup-wizard/scenes/web-search";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { SEARCH_PROVIDER_OPTIONS, SEARCH_PROVIDER_PREFERENCES } from "@veyyon/coding-agent/web/search/types";

function fakeContextWithConfiguredModel(): InteractiveModeContext {
	return {
		session: {
			modelRegistry: {
				getAvailable: () => [{ provider: "configured", id: "model" }],
			},
		},
		settings: Settings.isolated(),
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
}

function testScene(id: string, minVersion: number, shouldRun?: () => boolean): SetupScene {
	return {
		id,
		title: id,
		minVersion,
		shouldRun,
		mount: () => ({
			title: id,
			render: () => [],
			invalidate: () => {},
		}),
	};
}

// The import-config scene's shouldRun scans the real home for foreign configs
// (~/.claude etc.), which makes "all scenes selected" assertions depend on the
// developer's machine. The stub is a per-test spy on the imported namespace,
// undone by `restoreAllMocks` below. `mock.module` rewrites bun's PROCESS-GLOBAL
// module registry, so it stayed installed for every sibling file that linked its
// imports while this file was loaded, no matter what this file did afterwards.
//
// The stub DELEGATES: explicit-home calls (what import-scan.test.ts and the
// production tests pass) reach the real implementation; only the wizard's no-arg
// real-home scan is pinned to a deterministic non-empty result. The real function
// is read inside `beforeEach`, when the property is un-spied, so delegating never
// recurses into the spy.
beforeEach(async () => {
	// The theme singleton is initialised BEFORE each test, not only after. Scenes
	// render through `theme.fg(...)` the moment a selection is applied, and this
	// file used to seed the singleton only in `afterEach`, so whichever test ran
	// first found `theme` undefined. That is invisible in declaration order and
	// fires under `bun test --randomize`: seed=2 put "can select the last provider
	// in the setup TUI list" first and it died in web-search.ts on `theme.fg`.
	await initTheme(false, "unicode", false, "titanium", "light");

	const realScanForeignConfig = realImportScan.scanForeignConfig;
	vi.spyOn(realImportScan, "scanForeignConfig").mockImplementation(async (cwd?: string, home?: string) =>
		home !== undefined
			? realScanForeignConfig(cwd, home)
			: [{ kind: "skill", name: "probe", providerName: "Claude Code", sourcePath: "/nonexistent/probe" }],
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await initTheme(false, "unicode", false, "titanium", "light");
});

describe("setup wizard scene selection", () => {
	it("runs all v1 scenes for a new user", async () => {
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
	});

	it("pins CURRENT_SETUP_VERSION as a fixed generation, not the app version", () => {
		// The onboarding generation is a FIXED integer, deliberately decoupled from
		// the app version. This is the core of the first-install-only contract: if
		// the gate tracked the app version it would advance on a release and
		// re-onboard the whole base. It stays put so every update leaves onboarded
		// users alone. Also guard that no scene is stranded above the gate (which
		// would make it un-runnable) — every shipped scene must be within it.
		expect(CURRENT_SETUP_VERSION).toBe(1);
		expect(Math.max(...ALL_SCENES.map(scene => scene.minVersion))).toBeLessThanOrEqual(CURRENT_SETUP_VERSION);
	});

	it("never re-onboards after the first install: no update, minor or major, re-fires it", async () => {
		const scenes = [testScene("a", 1), testScene("b", 1), testScene("c", 1)];
		// An onboarded user is at the current generation. Because the production
		// gate never moves (CURRENT_SETUP_VERSION is fixed), no update can push the
		// stored generation behind it, so onboarding never runs again. Simulate the
		// two update shapes the app can ship — a same-generation launch, and even a
		// hypothetical generation ahead — and assert nothing runs in the real case.
		expect(
			await selectSetupScenes(CURRENT_SETUP_VERSION, scenes, fakeContextWithConfiguredModel(), {
				isTTY: true,
				currentVersion: CURRENT_SETUP_VERSION,
			}),
		).toEqual([]);
		// A fresh install (stored 0, below the fixed generation) is the ONE case
		// that onboards: every eligible scene runs, exactly once.
		const firstInstall = await selectSetupScenes(0, scenes, fakeContextWithConfiguredModel(), {
			isTTY: true,
			currentVersion: CURRENT_SETUP_VERSION,
		});
		expect(firstInstall.map(scene => scene.id)).toEqual(["a", "b", "c"]);
	});

	it("hides a scene staged for a future generation until the gate advances to it", async () => {
		// The per-scene minVersion floor still works as a staging mechanism, even
		// though the production gate is fixed: a scene whose floor is above the
		// current generation is withheld until the gate reaches it.
		const scenes = [testScene("now", 1), testScene("future", 2)];
		// At generation 1: the higher-floor scene is withheld.
		const atGen1 = await selectSetupScenes(0, scenes, fakeContextWithConfiguredModel(), {
			isTTY: true,
			currentVersion: 1,
		});
		expect(atGen1.map(scene => scene.id)).toEqual(["now"]);
		// If the gate ever advances to generation 2, the staged scene joins in.
		const atGen2 = await selectSetupScenes(1, scenes, fakeContextWithConfiguredModel(), {
			isTTY: true,
			currentVersion: 2,
		});
		expect(atGen2.map(scene => scene.id)).toEqual(["now", "future"]);
	});

	it("runs no scenes at the current setup version", async () => {
		const scenes = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, fakeContextWithConfiguredModel(), {
			isTTY: true,
		});
		expect(scenes).toEqual([]);
	});

	it("honors hard environment gates", async () => {
		const ctx = fakeContextWithConfiguredModel();
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: false })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, skipEnv: "1" })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, setupWizardEnabled: false })).toEqual([]);
	});

	it("defers a re-onboard while resuming but never a first install", async () => {
		// Resuming used to skip onboarding outright. Nothing else on that launch
		// records a generation, so a fresh machine launched with `--continue` stayed
		// indistinguishable from a fresh install and the wizard ambushed the user on
		// some later launch that happened to omit the flag.
		const ctx = fakeContextWithConfiguredModel();
		const firstInstall = await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, resuming: true });
		expect(firstInstall.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
		// A machine that HAS a recorded generation already: the deferral is one launch
		// long and the record survives it, so there is nothing to ambush.
		expect(await selectSetupScenes(1, ALL_SCENES, ctx, { isTTY: true, resuming: true, currentVersion: 2 })).toEqual(
			[],
		);
	});

	it("keeps the providers scene eligible even when a model is already configured", async () => {
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.some(scene => scene.id === "providers")).toBe(true);
	});

	it("force mode ignores version and user skip gates but still requires a TTY", async () => {
		const ctx = fakeContextWithConfiguredModel();
		const selected = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, ctx, {
			isTTY: true,
			setupWizardEnabled: false,
			skipEnv: "1",
			resuming: true,
			force: true,
		});
		expect(selected.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: false, force: true })).toEqual([]);
	});

	it("applies scene shouldRun only as a hard environment gate", async () => {
		const selected = await selectSetupScenes(
			0,
			[testScene("blocked", 1, () => false), testScene("allowed", 1, () => true)],
			fakeContextWithConfiguredModel(),
			{ isTTY: true },
		);
		expect(selected.map(scene => scene.id)).toEqual(["allowed"]);
	});
});

describe("setup wizard persistence", () => {
	it("marks the current setup version complete in the machine-wide store", () => {
		const settings = Settings.isolated();
		expect(markSetupWizardComplete(settings)).toBe(true);
		// `onboardingVersion`, not the retired per-profile `setupVersion`: completion
		// is a machine fact, so a profile switch cannot un-onboard the user.
		expect(settings.get("onboardingVersion")).toBe(CURRENT_SETUP_VERSION);
		expect(settings.get("setupVersion")).toBe(0);
	});

	it("can run a targeted scene without setup-version or welcome-intro side effects", async () => {
		const settings = Settings.isolated({ onboardingVersion: 0 });
		const hideOverlay = mock(() => {});
		const setFocus = mock((_component: unknown) => {});
		const requestRender = mock(() => {});
		const playWelcomeIntro = mock(() => {});
		let component: SetupWizardComponent | undefined;
		const scene: SetupScene = {
			id: "providers",
			title: "providers",
			minVersion: 1,
			mount: host => ({
				title: "providers",
				onMount: () => host.finish("done"),
				render: () => [],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings,
			playWelcomeIntro,
			ui: {
				terminal: { rows: 24 },
				showOverlay: (nextComponent: SetupWizardComponent) => {
					component = nextComponent;
					return { hide: hideOverlay };
				},
				setFocus,
				requestRender,
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;

		const pending = runSetupWizard(ctx, [scene], { markComplete: false, playWelcomeIntro: false });
		component?.handleInput?.("\n");
		component?.handleInput?.("\n");
		await pending;

		// `markComplete: false` means a targeted re-run (the provider-only flow) must
		// not claim the machine has been onboarded, even though the overlay went up.
		expect(settings.get("onboardingVersion")).toBe(0);
		expect(playWelcomeIntro).not.toHaveBeenCalled();
		expect(hideOverlay).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalled();
	});
});
describe("setup wizard mouse routing", () => {
	it("synthesizes arrow keys from wheel notches for scenes without routeMouse", () => {
		const received: string[] = [];
		const scene: SetupScene = {
			id: "scrollable",
			title: "scrollable",
			minVersion: 1,
			mount: () => ({
				title: "scrollable",
				handleInput: (data: string) => received.push(data),
				render: () => [],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(ctx, [scene]);
		try {
			void component.run();
			// Left click during the splash advances into the scene, like Enter.
			component.handleInput("\x1b[<0;5;5M");
			component.handleInput("\x1b[<64;10;5M"); // wheel up
			component.handleInput("\x1b[<65;10;5M"); // wheel down
			component.handleInput("\x1b[<35;10;5M"); // pointer motion — swallowed
			component.handleInput("\x1b[<0;10;5M"); // click in scene — swallowed
			expect(received).toEqual(["\x1b[A", "\x1b[B"]);
		} finally {
			component.dispose();
		}
	});

	it("swallows confirm keys while the scene is animating in, so a late splash-skip Enter cannot activate a scene control", () => {
		const received: string[] = [];
		const scene: SetupScene = {
			id: "signin-like",
			title: "signin-like",
			minVersion: 1,
			mount: () => ({
				title: "signin-like",
				handleInput: (data: string) => received.push(data),
				render: () => [],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(ctx, [scene]);
		try {
			void component.run();
			component.handleInput("\r"); // skip the splash
			component.handleInput("\r"); // lands during the scene-in transition — must be dropped
			component.handleInput(" "); // ditto for space
			component.handleInput("\x1b[B"); // navigation keys still pass through
			expect(received).toEqual(["\x1b[B"]);
		} finally {
			component.dispose();
		}
	});

	it("routes hit-tested mouse events at scene-local coordinates to scenes with routeMouse", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const routed: { kind: string; line: number; col: number }[] = [];
		const keys: string[] = [];
		const scene: SetupScene = {
			id: "mouse",
			title: "mouse",
			minVersion: 1,
			mount: () => ({
				title: "mouse",
				handleInput: (data: string) => keys.push(data),
				routeMouse: (event, line, col) => {
					const kind =
						event.wheel !== null
							? `wheel:${event.wheel}`
							: event.motion
								? "motion"
								: event.leftClick
									? "click"
									: "other";
					routed.push({ kind, line, col });
				},
				render: () => ["MARKER-ROW"],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(ctx, [scene]);
		try {
			void component.run();
			component.handleInput("\r"); // splash → scene
			await Bun.sleep(500); // let the splash→scene dissolve (420ms) finish so the frame is the scene
			const frame = component.render(80);
			const row = frame.findIndex(line => line.includes("MARKER-ROW"));
			expect(row).toBeGreaterThan(0);
			// Measure the indent on VISIBLE cells: frame rows carry styling escapes,
			// which a raw leading-space regex would read as zero indent.
			const indent = /^ */.exec(frame[row].replace(/\x1b\[[0-9;]*m/g, ""))?.[0].length ?? 0;
			expect(indent).toBeGreaterThan(0);
			// SGR reports are 1-based; two columns into the marker text.
			component.handleInput(`\x1b[<35;${indent + 3};${row + 1}M`);
			component.handleInput(`\x1b[<0;${indent + 3};${row + 1}M`);
			component.handleInput("\x1b[<64;1;1M"); // wheel forwards regardless of pointer position
			expect(routed.slice(0, 2)).toEqual([
				{ kind: "motion", line: 0, col: 2 },
				{ kind: "click", line: 0, col: 2 },
			]);
			expect(routed[2]?.kind).toBe("wheel:-1");
			// routeMouse scenes get no synthesized arrows and no raw SGR bytes.
			expect(keys).toEqual([]);
		} finally {
			component.dispose();
		}
	});
});

describe("setup wizard scene footer copy", () => {
	/**
	 * THE BUG THIS SUITE LOCKS OUT. The footer was one fixed string,
	 * "↑↓ select  ·  enter confirm  ·  esc skip  ·  ctrl+c exit", rendered
	 * identically under every scene. The Providers scene reaches its two panels
	 * only through Tab, and the footer named neither Tab nor any key that reads
	 * as "move on", so a user watching the tab bar cycle had no way to tell how
	 * to progress. Calling the forward key a skip made it worse: skipping is the
	 * one thing someone trying to finish setup will not press.
	 *
	 * The footer is composed from the ACTIVE scene now, and the key that advances
	 * the wizard is named apart from the key that confirms a choice inside it.
	 */
	/** A scene that renders nothing, so the footer is the only copy in the frame. */
	function emptyScene(id: string, keyHints?: () => readonly SetupKeyHint[]): SetupScene {
		return {
			id,
			title: id,
			minVersion: 1,
			mount: () => {
				const controller: SetupSceneController = { title: id, render: () => [], invalidate: () => {} };
				if (keyHints) controller.keyHints = keyHints;
				return controller;
			},
		};
	}

	/**
	 * Drive the wizard to its first scene and return that frame's footer, one
	 * line per rendered hint row.
	 *
	 * The footer is the trailing run of non-blank rows: the scenes here render an
	 * empty body, so everything above it is padding. It used to be `frame.at(-1)`,
	 * a single row, which stopped describing the footer once the hints started
	 * wrapping rather than being cut.
	 */
	async function footerOf(scenes: readonly SetupScene[], width = 100): Promise<string> {
		await initTheme(false, "unicode", false, "titanium", "light");
		const ctx = {
			settings: Settings.isolated(),
			// The Providers scene builds an OAuth panel from the auth storage. In
			// login mode it reads exactly these three: whether a provider is signed
			// in, and where its credential came from. Nothing is, so all three say no.
			session: {
				modelRegistry: {
					authStorage: { hasAuth: () => false, has: () => false, getCredentialOrigin: () => undefined },
				},
			},
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(ctx, scenes);
		// The wizard's phase clock is its own interval plus `performance.now()`,
		// and Bun's fake timers advance both, so the splash and the 420ms dissolve
		// are stepped through rather than waited out.
		vi.useFakeTimers();
		try {
			void component.run();
			component.handleInput("\r"); // splash → dissolve
			vi.advanceTimersByTime(500); // dissolve (420ms) completes → scene
			const frame = component.render(width);
			expect(frame.length).toBe(24);
			const rows = stripVTControlCharacters(frame.join("\n"))
				.split("\n")
				.map(row => row.trim());
			const firstFooterRow = rows.lastIndexOf("") + 1;
			return rows.slice(firstFooterRow).join("\n");
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	}

	/**
	 * The footer must name what each key DOES. `→` runs `#finishScene`, which
	 * advances the step index and commits nothing, so it is a skip; labelling it
	 * "next" beside "enter confirm" left no way to tell which one kept your
	 * choice. Locks the corrected labels so the old wording cannot come back.
	 */
	it("names forward navigation and setup skip apart from confirming a choice", async () => {
		expect(await footerOf([emptyScene("only")])).toBe("↑↓ select  ·  enter confirm  ·  → skip  ·  esc leave setup");
		expect(await footerOf([emptyScene("first"), emptyScene("second")])).toBe(
			"↑↓ select  ·  enter confirm  ·  → skip step  ·  esc leave setup",
		);
	});

	it("takes the in-scene keys from the active scene, so a tab bar puts Tab in the footer", async () => {
		const tabbed = emptyScene("tabbed", () => [
			{ keys: "tab", label: "switch panel" },
			{ keys: "enter", label: "confirm" },
		]);
		expect(await footerOf([tabbed])).toBe("tab switch panel  ·  enter confirm  ·  → skip  ·  esc leave setup");
		// A scene that declares nothing gets the default pair and never says Tab.
		expect(await footerOf([emptyScene("plain")])).toBe("↑↓ select  ·  enter confirm  ·  → skip  ·  esc leave setup");
	});

	/**
	 * The way out must be advertised as a key users will actually press. The only
	 * exit used to be ctrl+c, which reads as "kill the program", so the footer
	 * told people to abort in order to leave onboarding.
	 */
	it("offers Esc, not ctrl+c, as the advertised way out of setup", async () => {
		const footer = await footerOf([emptyScene("only")]);
		expect(footer).toContain("esc leave setup");
		expect(footer).not.toContain("ctrl+c");
	});

	it("the real Providers scene, the one users could not get out of, names Tab first", async () => {
		expect(await footerOf([providersSetupScene])).toBe(
			"tab switch panel  ·  ↑↓ select  ·  enter confirm  ·  → skip\nesc leave setup",
		);
	});

	/**
	 * THE BUG: the footer was one row, truncated, and the hints are ordered with
	 * the wizard's own keys last, so the row that ran past the frame lost `esc
	 * leave setup` first. At 80 columns that is every step with six hints, and
	 * the assertion this replaces pinned exactly that loss (it expected the row
	 * to end "→ …"). Wrapping keeps the exit on screen; a row still breaks only
	 * between hints, so no line ends on a bare key with no label.
	 */
	it("wraps the hints instead of cutting the way out off the end", async () => {
		const footer = await footerOf([providersSetupScene], 60);
		expect(footer).toBe("tab switch panel  ·  ↑↓ select  ·  enter confirm\n→ skip  ·  esc leave setup");
		for (const row of footer.split("\n")) expect(row.endsWith("…")).toBe(false);
	});
});

describe("setup wizard navigation and skip behavior", () => {
	function wizardContext(): InteractiveModeContext {
		return {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
		} as unknown as InteractiveModeContext;
	}

	function navigationScene(id: string, mounted: string[], unmounted: string[]): SetupScene {
		return {
			id,
			title: id,
			minVersion: 1,
			mount: () => {
				mounted.push(id);
				return {
					title: id,
					render: () => [],
					invalidate: () => {},
					onUnmount: () => {
						unmounted.push(id);
					},
				};
			},
		};
	}

	it("moves forward and back with the rendered arrow-key navigation", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const mounted: string[] = [];
		const unmounted: string[] = [];
		const component = new SetupWizardComponent(wizardContext(), [
			navigationScene("first", mounted, unmounted),
			navigationScene("second", mounted, unmounted),
		]);
		vi.useFakeTimers();
		try {
			void component.run();
			component.handleInput("\r");
			vi.advanceTimersByTime(500);
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("first");

			component.handleInput("\x1b[C");
			vi.advanceTimersByTime(500);
			const secondFrame = Bun.stripANSI(component.render(100).join("\n"));
			expect(secondFrame).toContain("second");
			expect(secondFrame).toContain("← back");

			component.handleInput("\x1b[D");
			vi.advanceTimersByTime(500);
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("first");
			expect(mounted).toEqual(["first", "second", "first"]);
			expect(unmounted).toEqual(["first", "second"]);
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	it("advertises and honors setup skip on the splash before mounting configuration scenes", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		let mounts = 0;
		const component = new SetupWizardComponent(wizardContext(), [
			{
				id: "configuration",
				title: "configuration",
				minVersion: 1,
				mount: () => {
					mounts += 1;
					return { title: "configuration", render: () => [], invalidate: () => {} };
				},
			},
		]);
		const done = component.run();
		const splash = component.render(100).map(line => Bun.stripANSI(line).trim());
		// Esc, not ctrl+c: one key means "leave setup" on the splash and on every
		// step. Advertising ctrl+c told a user that getting out of onboarding
		// meant killing the program, and Esc here used to START the wizard.
		expect(splash.at(-2)).toBe("enter start setup  ·  esc skip setup");

		component.handleInput("\x1b");
		component.handleInput("\r");
		await done;
		expect(mounts).toBe(0);
		component.dispose();
	});
});

describe("setup wizard theme previews", () => {
	/** Mount the theme scene against an isolated profile, and report what it finished with. */
	async function mountThemeScene(settings: Settings): Promise<{
		controller: SetupSceneController;
		finished: string[];
	}> {
		const setupScene = ALL_SCENES.find(scene => scene.id === "theme");
		expect(setupScene).toBeDefined();
		const finished: string[] = [];
		const host = {
			ctx: {
				settings,
				ui: {
					invalidate: () => {},
					requestRender: () => {},
				},
			},
			requestRender: () => {},
			finish: (result: string) => finished.push(result),
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;
		return { controller: setupScene!.mount(host), finished };
	}

	/**
	 * Leaving the step puts back the glyph preset a preview changed.
	 *
	 * This is the guarantee that makes previewing safe to do at all: the step
	 * repaints the live theme as you move through it, so a user who arrives with
	 * Nerd Font glyphs, turns ASCII on to look at it, and then leaves must get
	 * their glyphs back. Nothing else covers it. The test this replaced asserted
	 * the same restore against an "ANSI-safe" ROW that ended the step, which is
	 * the design the toggles removed; see
	 * `test/modes/setup-wizard/theme-scene-modifiers-compose.test.ts`.
	 *
	 * THE EXIT IS `onUnmount`, NOT AN ESCAPE KEYSTROKE. This case used to send
	 * `\x1b` straight to the controller, which reached the list's cancel ladder
	 * and a `SelectList.onCancel` that restored and finished. No user can do
	 * that: the wizard owns Escape and only forwards it to a scene that claims
	 * it, which this one does only while browsing all themes. So the test passed
	 * on a path that did not exist, while every real way out of the step — Esc,
	 * `→`, `←`, ctrl+c — left the previewed preset applied for the rest of the
	 * session. All four now run through `onUnmount`, and so does this.
	 */
	it("restores the glyph preset when the step is left after previewing ASCII", async () => {
		await initTheme(false, "nerd", false, "titanium", "light");
		const settings = Settings.isolated({ symbolPreset: "nerd", colorBlindMode: false });
		const { controller, finished } = await mountThemeScene(settings);

		// Row 6 is the ASCII toggle. The digit only moves the cursor onto it;
		// enter is what flips it, which is the whole point of a toggle.
		controller.handleInput?.("6");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("nerd");

		controller.handleInput?.("\r");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("ascii");

		await controller.onUnmount?.();
		// Leaving is the wizard's business, so the scene reports no result at all.
		expect(finished).toEqual([]);
		expect(theme.getSymbolPreset()).toBe("nerd");
		expect(settings.get("symbolPreset")).toBe("nerd");
	});

	/**
	 * And moving the cursor onto a theme row does not lose it either.
	 *
	 * The preview reapplies the modifiers before it loads a theme, so a theme
	 * whose own file says nothing about glyphs cannot reset them. Without that
	 * order, arrowing through the list would silently drop the user back to the
	 * default preset partway down.
	 */
	it("keeps the glyph preset while previewing a theme row", async () => {
		await initTheme(false, "nerd", false, "titanium", "light");
		const settings = Settings.isolated({ symbolPreset: "nerd", colorBlindMode: false });
		const { controller } = await mountThemeScene(settings);

		controller.handleInput?.("3");
		await Bun.sleep(20);

		expect(theme.getSymbolPreset()).toBe("nerd");
	});
});

describe("setup wizard glyph scene", () => {
	it("lists Nerd Font first and commits the chosen preset", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const settings = Settings.isolated();
		const scene = ALL_SCENES.find(s => s.id === "glyph-mode");
		expect(scene).toBeDefined();

		let finished = false;
		const host = {
			ctx: {
				settings,
				ui: { invalidate: () => {}, requestRender: () => {} },
			},
			requestRender: () => {},
			finish: () => {
				finished = true;
			},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const controller = scene!.mount(host);
		// Row "1" is now Nerd Font (it must lead the list).
		controller.handleInput?.("1");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("nerd");

		controller.handleInput?.("\n");
		await Bun.sleep(20);
		expect(settings.get("symbolPreset")).toBe("nerd");
		expect(finished).toBe(true);
	});
});

describe("setup wizard web search tab", () => {
	it("exposes every web-search provider preference in the schema-backed TUI list", () => {
		const schema = SETTINGS_SCHEMA["providers.webSearch"];
		expect(schema.values).toEqual(SEARCH_PROVIDER_PREFERENCES);
		expect(SEARCH_PROVIDER_OPTIONS.length).toBeGreaterThan(1);
	});

	it("persists the highlighted provider as the web search preference", async () => {
		const settings = Settings.isolated();
		const host = {
			ctx: {
				settings,
				session: { modelRegistry: { authStorage: { hasAuth: () => false } } },
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const tab = new WebSearchTab(host);
		tab.handleInput("\x1b[B"); // move off "auto" to the next provider
		tab.handleInput("\n"); // confirm the highlighted provider
		await Bun.sleep(20);

		const expected = SEARCH_PROVIDER_OPTIONS[1].value;
		expect(expected).not.toBe("auto");
		expect(settings.get("providers.webSearch")).toBe(expected);
	});

	it("can select the last provider in the setup TUI list", async () => {
		const settings = Settings.isolated();
		const host = {
			ctx: {
				settings,
				session: { modelRegistry: { authStorage: { hasAuth: () => false } } },
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const tab = new WebSearchTab(host);
		for (let i = 1; i < SEARCH_PROVIDER_OPTIONS.length; i++) {
			tab.handleInput("\x1b[B");
		}
		tab.handleInput("\n");
		await Bun.sleep(20);

		const lastOption = SEARCH_PROVIDER_OPTIONS[SEARCH_PROVIDER_OPTIONS.length - 1]!;
		expect(settings.get("providers.webSearch")).toBe(lastOption.value);
	});
});

describe("veyyon setup onboarding trigger", () => {
	it("starts the normal interactive command with forced setup wizard", async () => {
		let forceSetupWizard: boolean | undefined;
		await runOnboardingSetup({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			runRoot: async (_parsed, _rawArgs, deps) => {
				forceSetupWizard = deps?.forceSetupWizard;
			},
		});
		expect(forceSetupWizard).toBe(true);
	});

	it("rejects onboarding setup without an interactive TTY", async () => {
		let stderr = "";
		let exitCode: number | undefined;
		await expect(
			runOnboardingSetup({
				stdinIsTTY: false,
				stdoutIsTTY: true,
				writeStderr: text => {
					stderr += text;
				},
				exit: code => {
					exitCode = code;
					throw new Error("exit");
				},
			}),
		).rejects.toThrow("exit");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("interactive TTY");
	});
});

describe("setup wizard scene alignment", () => {
	it("anchors wordmark, step counter, title, body, and footer on one left column", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const scenes = [
			{
				id: "align-a",
				title: "Align check",
				minVersion: 1,
				mount: () => ({
					title: "Align check",
					render: () => ["BODY-MARKER"],
					invalidate: () => {},
				}),
			},
			testScene("align-b", 1),
		];
		const ctx = {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(ctx, scenes);
		try {
			void component.run();
			component.handleInput("\r"); // splash → scene
			await Bun.sleep(500); // let the splash→scene dissolve finish
			const frame = component.render(80).map(line => stripVTControlCharacters(line));
			const indentOf = (predicate: (line: string) => boolean): number => {
				const line = frame.find(predicate);
				expect(line).toBeDefined();
				return /^ */.exec(line ?? "")?.[0].length ?? 0;
			};
			// Every header/body/footer row shares one left anchor — nothing floats
			// centered above left-aligned content. The progress row is the
			// breadcrumb, which leads with the `1/2` step counter.
			const wordmark = indentOf(line => line.includes("v e y y o n"));
			const step = indentOf(line => line.includes("1/2"));
			const title = indentOf(line => line.trimStart().startsWith("Align check"));
			const body = indentOf(line => line.includes("BODY-MARKER"));
			const footer = indentOf(line => line.includes("enter confirm"));
			expect(step).toBe(wordmark);
			expect(title).toBe(wordmark);
			expect(body).toBe(wordmark);
			expect(footer).toBe(wordmark);
		} finally {
			component.dispose();
		}
	});
});

describe("theme scene rhythm", () => {
	it("starts curated mode straight at the preview — no leading blank rows", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const host = {
			ctx: { settings: Settings.isolated() },
			next: () => {},
			invalidate: () => {},
		} as unknown as Parameters<(typeof themeSetupScene)["mount"]>[0];
		const controller = await themeSetupScene.mount(host);
		try {
			const lines = controller.render(76).map(line => stripVTControlCharacters(line));
			// The wizard header already ends in one blank line; a scene that leads
			// with its own blanks breaks the shared one-blank rhythm.
			expect(lines[0]?.trim().length).toBeGreaterThan(0);
		} finally {
			controller.dispose?.();
		}
	});
});

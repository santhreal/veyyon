/**
 * THE FOOTER'S ESC LABEL IS A PROMISE, AND ESC HAS TO KEEP IT.
 *
 * Onboarding is the first thing a new user touches, and Escape is the key they
 * reach for when they mistype. The wizard owns Escape and ends the whole run
 * with it, so any scene that ALSO wants Escape (to clear a search, to back out
 * of a sub-mode) has to claim it through `escapeAction`, which is the same
 * value the footer prints. Two shipped bugs came from that pair disagreeing:
 * Escape ended the run on step 1 (the provider search) and step 5 (the theme
 * list, searchable at 80x24) after a single typed character.
 *
 * WHAT IS PINNED HERE is the invariant that covers all of them without naming
 * scenes: at every size, for every shipped scene, the run ends on Escape if and
 * only if the footer said `esc leave setup`. A scene that starts consuming
 * Escape without saying so fails, and so does one that advertises `esc clear
 * search` over a key that quits.
 *
 * The resize case has its own test because it is the one the invariant above
 * cannot reach by typing alone: the provider selector decided whether its
 * search was live from the CURRENT row budget, so growing the terminal until
 * every provider fit made a typed query un-backspaceable and handed Escape back
 * to the wizard while a filtered list was still on screen.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ImportCandidate } from "@veyyon/coding-agent/discovery/import-scan";
import { AgentsSceneController, agentsSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/agents";
import { approvalsSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/approvals";
import { glyphSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/glyph";
import { ImportSceneController, importSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";
import { providersSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/providers";
import { themeSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/theme";
import type {
	SetupScene,
	SetupSceneHost,
	SetupWizardContext,
} from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { useTempHome } from "./helpers/temp-home";

/**
 * The import and subagents scenes fill their rows from `shouldRun`, which scans
 * the machine's real home. They are mounted on fixtures below and never through
 * `shouldRun`; the redirect is the second half of that guarantee.
 */
useTempHome();

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

function makeContext(terminal: { rows: number }, onRender: () => void = () => {}): SetupWizardContext {
	return {
		settings: Settings.isolated(),
		session: {
			modelRegistry: {
				authStorage: { hasAuth: () => false, has: () => false, getCredentialOrigin: () => undefined },
				getAvailable: () => [],
			},
		},
		openInBrowser: () => {},
		showError: () => {},
		ui: { terminal, setFocus: () => {}, requestRender: onRender, invalidate: () => {} },
	} as unknown as SetupWizardContext;
}

const AGENT_FIXTURE: readonly AgentDefinition[] = ["task", "scout", "designer", "reviewer", "librarian", "sonic"].map(
	name => ({
		name,
		description: `The ${name} subagent, described in one full sentence so the detail block has real text to wrap.`,
		systemPrompt: "",
		source: "bundled" as const,
	}),
);

const IMPORT_FIXTURE: readonly ImportCandidate[] = [
	{ kind: "skill", name: "code-review", providerName: "Claude Code", sourcePath: "/fixture/.claude/skills/cr.md" },
	{ kind: "skill", name: "release", providerName: "Claude Code", sourcePath: "/fixture/.claude/skills/rel.md" },
	{ kind: "instructions", name: "CLAUDE.md", providerName: "Claude Code", sourcePath: "/fixture/CLAUDE.md" },
	{ kind: "instructions", name: "AGENTS.md", providerName: "Codex", sourcePath: "/fixture/.codex/AGENTS.md" },
];

const SCENES: ReadonlyArray<readonly [string, SetupScene]> = [
	["providers", providersSetupScene],
	["approvals", approvalsSetupScene],
	[
		"subagents",
		{
			...agentsSetupScene,
			shouldRun: undefined,
			mount: (host: SetupSceneHost) => new AgentsSceneController(host, AGENT_FIXTURE),
		},
	],
	["glyph", glyphSetupScene],
	["theme", themeSetupScene],
	[
		"import",
		{
			...importSetupScene,
			shouldRun: undefined,
			mount: (host: SetupSceneHost) => new ImportSceneController(host, [...IMPORT_FIXTURE]),
		},
	],
];

/** Terminal sizes onboarding actually runs at, smallest first. */
const SIZES: ReadonlyArray<readonly [number, number]> = [
	[80, 24],
	[60, 24],
	[100, 30],
];

function plain(frame: readonly string[]): string {
	return frame.map(row => row.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

/**
 * Drive one scene to its settled phase, run `act`, then press Escape and report
 * both what the footer promised beforehand and whether the run ended.
 */
async function escapeOutcome(
	scene: SetupScene,
	width: number,
	terminal: { rows: number },
	act: (component: SetupWizardComponent) => void,
): Promise<{ footer: string; runEnded: boolean }> {
	const component = new SetupWizardComponent(makeContext(terminal), [scene]);
	vi.useFakeTimers();
	let runEnded = false;
	try {
		void component.run().then(() => {
			runEnded = true;
		});
		component.handleInput("\r"); // leave the splash
		vi.advanceTimersByTime(500); // let the dissolve settle
		component.render(width);
		act(component);
		const footer = plain(component.render(width));
		component.handleInput("\x1b");
		// The outro plays before the run resolves; let its timer elapse, then let
		// the resolution's microtask run before reading the flag it sets.
		vi.advanceTimersByTime(5000);
		await Promise.resolve();
		return { footer, runEnded };
	} finally {
		vi.useRealTimers();
		component.dispose();
	}
}

describe("Escape does what the footer says it does", () => {
	for (const [width, rows] of SIZES) {
		for (const [name, scene] of SCENES) {
			/**
			 * One typed character is the whole reproduction: it is what turns a
			 * searchable list's Escape from "close" into "clear", and it is what a
			 * user does before reaching for Escape to undo it.
			 */
			it(`${name} at ${width}x${rows}, after one typed character`, async () => {
				const { footer, runEnded } = await escapeOutcome(scene, width, { rows }, component => {
					component.handleInput("a");
				});
				const advertisedQuit = footer.includes("esc leave setup");
				expect(footer).toMatch(/esc \w/);
				expect(runEnded).toBe(advertisedQuit);
			});

			/** With nothing typed, no scene may hold Escape: it is the advertised exit. */
			it(`${name} at ${width}x${rows}, untouched, leaves setup`, async () => {
				const { footer, runEnded } = await escapeOutcome(scene, width, { rows }, () => {});
				expect(footer).toContain("esc leave setup");
				expect(runEnded).toBe(true);
			});
		}
	}
});

describe("ctrl+c always ends the run", () => {
	for (const [name, scene] of SCENES) {
		/**
		 * Ctrl+C is the one exit the footer promises even while a scene has taken
		 * Escape for itself, so it may never be swallowed by a scene's own list.
		 */
		it(`${name}, mid-search`, async () => {
			const component = new SetupWizardComponent(makeContext({ rows: 24 }), [scene]);
			vi.useFakeTimers();
			let runEnded = false;
			try {
				void component.run().then(() => {
					runEnded = true;
				});
				component.handleInput("\r");
				vi.advanceTimersByTime(500);
				component.render(80);
				component.handleInput("a");
				component.render(80);
				component.handleInput("\x03");
				vi.advanceTimersByTime(5000);
				await Promise.resolve();
				expect(runEnded).toBe(true);
			} finally {
				vi.useRealTimers();
				component.dispose();
			}
		});
	}
});

describe("a typed search survives a terminal resize", () => {
	/**
	 * THE BUG: `OAuthSelectorComponent` decided whether its search was live from
	 * `allProviders.length > maxVisible`, and the wizard re-sizes the selector on
	 * every render. Type one character at 80x24, then grow the terminal until
	 * every provider fits, and the query became unreachable: backspace refused
	 * it, `hasActiveSearch()` went false, so the wizard took Escape back, and the
	 * next Escape ended onboarding with a filtered list still on screen. The
	 * footer, computed from the previous frame's budget, still read `esc clear
	 * search` while it did.
	 *
	 * `SelectList` had already been fixed this way; this selector had not.
	 *
	 * STARTING A NEW search once everything fits is still refused, and that is
	 * correct: with no rows hidden there is nothing to narrow, and the status row
	 * that would show the query is not drawn. What may not happen is a query the
	 * user already typed becoming unreachable underneath them.
	 */
	function typeThenGrow(): { component: SetupWizardComponent; ended: () => boolean } {
		const terminal = { rows: 24 };
		const component = new SetupWizardComponent(makeContext(terminal), [providersSetupScene]);
		let runEnded = false;
		void component.run().then(() => {
			runEnded = true;
		});
		component.handleInput("\r");
		vi.advanceTimersByTime(500);
		component.render(80);
		component.handleInput("o");
		expect(plain(component.render(80))).toContain("Search: o");
		// Grow past the provider count, which is what used to disable the search.
		terminal.rows = 80;
		const grown = plain(component.render(80));
		expect(grown).toContain("Search: o");
		expect(grown).toContain("esc clear search");
		return { component, ended: () => runEnded };
	}

	it("still clears the query on Escape instead of ending the run", async () => {
		vi.useFakeTimers();
		const { component, ended } = typeThenGrow();
		try {
			component.handleInput("\x1b");
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			expect(ended()).toBe(false);
			const cleared = plain(component.render(80));
			expect(cleared).not.toContain("Search: o");
			expect(cleared).toContain("esc leave setup");
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});

	it("still edits the query on backspace", () => {
		vi.useFakeTimers();
		const { component } = typeThenGrow();
		try {
			component.handleInput("\x7f");
			expect(plain(component.render(80))).not.toContain("Search: o");
		} finally {
			vi.useRealTimers();
			component.dispose();
		}
	});
});

describe("the theme step's own Esc sub-state", () => {
	/**
	 * "Browse all themes" is the only sub-mode any scene enters, and its own
	 * on-screen line has always read "Esc returns to curated choices" while Esc
	 * actually ended the run. It is also the ONE `SelectList.onCancel` the wizard
	 * can still reach, because the wizard hands Esc to a scene only while that
	 * scene claims it, so the branch is worth pinning against a refactor that
	 * trims the cancel handlers around it as dead.
	 *
	 * Driven at the SCENE, because `escapeAction` is the value the wizard reads
	 * to decide who gets the key and the same value the footer prints, so this is
	 * both halves of the promise in one place.
	 */
	it("claims Esc while browsing all themes, and returns to the curated rows", async () => {
		let painted: PromiseWithResolvers<void> | undefined;
		const host = {
			ctx: makeContext({ rows: 40 }, () => painted?.resolve()),
			requestRender: () => painted?.resolve(),
			finish: (result: string) => finished.push(result),
			skipSetup: () => finished.push("skipped-setup"),
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;
		const finished: string[] = [];
		const scene = themeSetupScene.mount(host);
		try {
			scene.render(76, 24);
			expect(scene.escapeAction?.()).toBeUndefined();

			scene.handleInput?.("4"); // move onto "Browse all…"
			painted = Promise.withResolvers<void>();
			scene.handleInput?.("\r"); // enter it: this reads the theme directory
			await painted.promise;
			while (!plain(scene.render(76, 24)).includes("Browsing all themes")) {
				painted = Promise.withResolvers<void>();
				await painted.promise;
			}

			// The scene now owns Esc, and says so in the words the footer prints.
			expect(scene.escapeAction?.()).toEqual({ keys: "esc", label: "back to curated" });

			scene.handleInput?.("\x1b");
			const back = plain(scene.render(76, 24));
			expect(back).not.toContain("Browsing all themes");
			expect(back).toContain("Browse all…");
			// Back in the curated list, Esc belongs to the wizard again.
			expect(scene.escapeAction?.()).toBeUndefined();
			// And returning from the sub-mode is not leaving the step.
			expect(finished).toEqual([]);
		} finally {
			await scene.onUnmount?.();
			scene.dispose?.();
		}
	});
});

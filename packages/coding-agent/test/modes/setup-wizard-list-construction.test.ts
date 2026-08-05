/**
 * Two contracts every list in onboarding must keep, checked over ALL of them
 * rather than over the ones someone remembered.
 *
 * 1. NO SCENE PRINTS THE LIST'S OWN KEY LEGEND. `SelectList` writes
 *    "↑↓ move · ↵ select · esc close" on its status row, which is right for a
 *    picker that owns the screen and a lie inside the wizard: the footer already
 *    names the keys for the whole step, and Esc belongs to the wizard, not the
 *    list. Suppressing it was an opt-out (`statusLegend: false`) that every
 *    scene had to remember, and the approvals scene did not. It got away with it
 *    only because four rows never overflow, so the status row never rendered.
 *    An opt-out that is load-bearing and silently unenforced is the same defect
 *    as no opt-out at all, so scenes now go through `createWizardList`, which
 *    does not accept the option at all.
 *
 * 2. EVERY SEARCHABLE LIST CLAIMS ESCAPE WHILE IT IS FILTERED. A list becomes
 *    type-to-filter the moment it holds more rows than the terminal leaves it,
 *    which is a row budget, not a property of the scene: the theme step's six
 *    curated rows turn searchable at 80x24. A filtered list consumes Escape to
 *    clear itself, so a scene that does not claim Escape hands it to the wizard,
 *    which ENDS ONBOARDING. That cost the operator step 1 and step 5.
 *
 * IF EITHER REGRESSES: a wizard step advertises a key meaning the key does not
 * have, and in case 2 the key that undoes a typo ends the run instead.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ImportCandidate } from "@veyyon/coding-agent/discovery/import-scan";
import { AgentsSceneController } from "@veyyon/coding-agent/modes/setup-wizard/scenes/agents";
import { approvalsSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/approvals";
import { glyphSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/glyph";
import { ImportSceneController } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";
import { providersSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/providers";
import { themeSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/theme";
import type {
	SetupSceneController,
	SetupSceneHost,
	SetupWizardContext,
} from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { WebSearchTab } from "@veyyon/coding-agent/modes/setup-wizard/scenes/web-search";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false, "unicode", false, "titanium", "light");
});

function makeHost(): SetupSceneHost {
	const ctx = {
		settings: Settings.isolated(),
		session: {
			modelRegistry: {
				authStorage: { hasAuth: () => false, has: () => false, getCredentialOrigin: () => undefined },
				getAvailable: () => [],
				refresh: async () => {},
			},
		},
		openInBrowser: () => {},
		showError: () => {},
		ui: { terminal: { rows: 24 }, setFocus: () => {}, invalidate: () => {}, requestRender: () => {} },
	} as unknown as SetupWizardContext;
	return {
		ctx,
		requestRender: () => {},
		finish: () => {},
		skipSetup: () => {},
		setFocus: () => {},
		restoreFocus: () => {},
	};
}

/** Eight roles: more than any tight row budget, so the list is searchable. */
const AGENTS: readonly AgentDefinition[] = ["task", "scout", "designer", "reviewer", "librarian", "sonic"].map(
	name => ({ name, description: `The ${name} role.`, systemPrompt: "", source: "bundled" as const }),
);

const CANDIDATES: readonly ImportCandidate[] = ["one", "two", "three", "four", "five"].map(name => ({
	kind: "skill" as const,
	name,
	providerName: "Claude Code",
	sourcePath: `/fixture/.claude/skills/${name}.md`,
}));

/** Every scene that mounts a picker, by the id the wizard knows it as. */
const LIST_SCENE_IDS = ["providers", "approvals", "subagents", "glyph-mode", "theme", "import-config"] as const;

/**
 * Mount one, in the state onboarding shows it.
 *
 * `subagents` and `import-config` take their rows as a constructor argument
 * (their scenes fill them by scanning the machine, which a test must not do),
 * so they are built directly; the rest are mounted through their scene exactly
 * as the wizard mounts them. Called inside each case, never at collection time:
 * the rows carry theme glyphs, and the theme is initialised in `beforeAll`.
 */
function mountScene(id: (typeof LIST_SCENE_IDS)[number]): SetupSceneController {
	switch (id) {
		case "providers":
			return providersSetupScene.mount(makeHost());
		case "approvals":
			return approvalsSetupScene.mount(makeHost());
		case "subagents":
			return new AgentsSceneController(makeHost(), AGENTS);
		case "glyph-mode":
			return glyphSetupScene.mount(makeHost());
		case "theme":
			return themeSetupScene.mount(makeHost());
		case "import-config":
			return new ImportSceneController(makeHost(), [...CANDIDATES]);
	}
}

const WIDTH = 72;
/**
 * Two body budgets, because "searchable" is a function of the budget, not of
 * the scene. Measured over these six scenes: at 8 rows providers, theme and
 * import overflow; at 12 the theme preview and the import list fit again while
 * the subagents list, which reserves four rows for its detail block, does not.
 * Neither budget alone reaches every list, and a sweep is the only way this
 * table is not quietly vacuous for half its rows.
 */
const BUDGETS = [8, 12] as const;

/** Lists that must overflow at one of {@link BUDGETS}, so their case is live. */
const MUST_BE_SEARCHABLE_SOMEWHERE = ["providers", "subagents", "theme", "import-config"] as const;

function body(controller: SetupSceneController, rows: number): string {
	return controller
		.render(WIDTH, rows)
		.map(row => stripVTControlCharacters(row))
		.join("\n");
}

describe("no wizard list prints the picker's own key legend", () => {
	for (const id of LIST_SCENE_IDS) {
		for (const rows of BUDGETS) {
			it(`${id} shows its search row without a key legend at ${rows} rows`, () => {
				const controller = mountScene(id);
				try {
					// Rendered once to apply the row budget, then filtered, because the
					// legend text differs between "esc close" and "esc clear".
					body(controller, rows);
					controller.handleInput?.("e");
					const filtered = body(controller, rows);

					expect(filtered).not.toContain("esc close");
					expect(filtered).not.toContain("esc clear");
					expect(filtered).not.toContain("↑↓ move");
					expect(filtered).not.toContain("↵ select");
				} finally {
					controller.dispose?.();
				}
			});
		}
	}
});

describe("every searchable wizard list claims Escape while it is filtered", () => {
	/** Filled by the cases below, then checked for vacuity at the end. */
	const searchableSomewhere = new Set<string>();

	for (const id of LIST_SCENE_IDS) {
		for (const rows of BUDGETS) {
			it(`${id} names Escape correctly at ${rows} rows`, () => {
				const controller = mountScene(id);
				try {
					body(controller, rows);
					expect(controller.escapeAction?.()).toBeUndefined();

					controller.handleInput?.("e");
					const filtered = body(controller, rows);
					const isSearchable = filtered.includes("Search: e");
					if (isSearchable) searchableSomewhere.add(id);
					const claim = controller.escapeAction?.();

					if (isSearchable) {
						// The claim IS the footer hint: the wizard prints the object
						// returned here, so an accurate claim cannot carry wrong text.
						expect(claim).toEqual({ keys: "esc", label: "clear search" });
					} else {
						// A list Escape cannot clear must not take Escape from the
						// wizard, or the only advertised way out stops responding.
						expect(claim).toBeUndefined();
					}

					// Either way, Escape must return the list to its unfiltered state
					// rather than leave a query nothing on screen can reach.
					controller.handleInput?.("\x1b");
					expect(body(controller, rows)).not.toContain("Search: e");
					expect(controller.escapeAction?.()).toBeUndefined();
				} finally {
					controller.dispose?.();
				}
			});
		}
	}

	/**
	 * The guard against a table that passes because nothing in it is searchable.
	 * Every list long enough to overflow must actually overflow at one of the
	 * budgets above, or the claim branch never runs and this suite would keep
	 * passing through the exact regression it exists to catch.
	 */
	it("actually exercised the searchable branch on every long list", () => {
		expect([...searchableSomewhere].toSorted()).toEqual([...MUST_BE_SEARCHABLE_SOMEWHERE].toSorted());
	});
});

describe("the web-search panel answers for its own list", () => {
	/**
	 * The tabbed providers scene forwards `escapeAction` to the active tab. The
	 * second tab is reachable only by pressing Tab, so it is exercised directly:
	 * a scene-level answer is what lost this panel's claim in the first place.
	 */
	it("claims Escape while its provider list is filtered", () => {
		const tab = new WebSearchTab(makeHost());
		try {
			tab.render(WIDTH, BUDGETS[0]);
			expect(tab.escapeAction?.()).toBeUndefined();

			tab.handleInput("e");
			const filtered = stripVTControlCharacters(tab.render(WIDTH, BUDGETS[0]).join("\n"));
			expect(filtered).toContain("Search: e");
			expect(tab.escapeAction?.()).toEqual({ keys: "esc", label: "clear search" });

			tab.handleInput("\x1b");
			expect(stripVTControlCharacters(tab.render(WIDTH, BUDGETS[0]).join("\n"))).not.toContain("Search: e");
		} finally {
			tab.dispose();
		}
	});
});

describe("scenes build their lists through the wizard factory", () => {
	/**
	 * The behavioural checks above can only see the lists that exist today. This
	 * is what stops the NEXT scene from reintroducing the defect: a direct
	 * `new SelectList(...)` is how a scene gets the legend back, and nothing in
	 * the type system can refuse it. `createWizardList` does not accept
	 * `statusLegend` at all, so going through it makes the mistake unavailable.
	 */
	it("no scene constructs SelectList directly", () => {
		const sceneDir = path.join(import.meta.dir, "../../src/modes/setup-wizard/scenes");
		const offenders = fs
			.readdirSync(sceneDir)
			.filter(name => name.endsWith(".ts") && name !== "wizard-list.ts")
			.filter(name => fs.readFileSync(path.join(sceneDir, name), "utf8").includes("new SelectList("));

		expect(offenders).toEqual([]);
	});
});

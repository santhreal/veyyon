/**
 * Navigating the plugin settings panel must leave exactly one view mounted, and it must be the view the
 * panel thinks it is showing.
 *
 * WHY THIS SUITE EXISTS. `PluginSettingsComponent` used to track its own position with three fields that
 * nothing read: `#currentView` (the string "list" / "npm-detail" / "marketplace-detail"), `#currentPlugin`
 * and `#currentMarketplacePlugin`, each assigned at every transition and each carrying a `biome-ignore`
 * calling itself "state tracking for view management". They were a second state machine running beside
 * the real one -- `#viewComponent`, the child actually mounted -- so the only thing they could contribute
 * was disagreement: a transition that updated one and not the other, or a field left pointing at the
 * plugin from the previous screen. The fields are gone and `#viewComponent` is the single representation.
 *
 * Nothing exercised the transitions, which is how a write-only state machine survived that long. This
 * suite drives the real path -- list, into an npm detail, back, into a marketplace detail, back -- and at
 * every step classifies the RENDERED output, because rendered output is what a user sees and it cannot be
 * satisfied by a field that agrees with itself. `viewOf` fails on ambiguity as loudly as it fails on the
 * wrong answer: a transition that mounts a new view without clearing the old one renders both footers,
 * which is the exact shape the deleted fields would have hidden.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins";
import {
	type InstalledPluginSummary,
	MarketplaceManager,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@veyyon/coding-agent/extensibility/plugins/types";
import { PluginSettingsComponent } from "@veyyon/coding-agent/modes/components/plugin-settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/**
 * The marker each view renders, and the only per-view string that is not shared with any other view: the
 * list heads itself "Plugins", the npm detail describes its toggle as "this plugin", the marketplace
 * detail as "this marketplace plugin". Classifying on a plugin name is not possible -- a name appears in
 * the list AND in its own detail view -- and the dim hint footers this used to read ("Enter to configure"
 * and friends) are gone: the keys are footer chips on the settings card now, so the panel no longer
 * prints them. `shortcuts()` is asserted separately, since it is what the card paints.
 */
const VIEW_MARKERS = {
	list: "Plugins",
	"npm-detail": "Enable or disable this plugin",
	"marketplace-detail": "Enable or disable this marketplace plugin",
} as const;

/** The chip labels each view hands the settings card, in order. */
const VIEW_CHIPS = {
	list: ["up/down navigate", "enter configure", "esc close"],
	"npm-detail": ["up/down navigate", "enter edit", "esc back"],
	"marketplace-detail": ["up/down navigate", "enter toggle", "esc back"],
} as const;

type ViewName = keyof typeof VIEW_MARKERS;

/**
 * Which view the panel is actually showing, read off its own output.
 *
 * Returns "loading" while no view has mounted (the list view mounts from an async listing, so the first
 * frames are legitimately empty), and throws on more than one match rather than picking a winner: two
 * views rendering at once is the failure this file exists to catch, and a classifier that silently
 * returned the first hit would report a clean transition through a panel showing two screens stacked.
 */
function viewOf(component: PluginSettingsComponent): ViewName | "loading" {
	const text = stripVTControlCharacters(component.render(120).join("\n"));
	const matches = (Object.keys(VIEW_MARKERS) as ViewName[]).filter(view => text.includes(VIEW_MARKERS[view]));
	if (matches.length > 1) {
		throw new Error(`plugin settings rendered ${matches.length} views at once: ${matches.join(", ")}\n${text}`);
	}
	return matches[0] ?? "loading";
}

/** Chip labels the panel is currently handing its host, stripped of styling. */
function chipsOf(component: PluginSettingsComponent): string[] {
	return component.shortcuts().map(shortcut => stripVTControlCharacters(shortcut.label));
}

/** The rendered panel, for assertions about which plugin the current view is about. */
function textOf(component: PluginSettingsComponent): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

/**
 * Every transition is asynchronous somewhere: the list view awaits two registry listings, and the npm
 * detail view awaits its settings read. Polling on the rendered view is what the production TUI does too
 * (it repaints on request), so waiting this way exercises the same frames a user would see.
 */
async function waitForView(component: PluginSettingsComponent, expected: ViewName): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (viewOf(component) === expected) return;
		await Bun.sleep(1);
	}
	throw new Error(`plugin settings never reached the ${expected} view; it is showing ${viewOf(component)}`);
}

const npmPlugin: InstalledPlugin = {
	name: "npm-side",
	version: "1.2.3",
	path: "/cache/npm/npm-side",
	// No `settings` and no `features`: the detail view then needs no disk read, so the transition under
	// test is the only asynchronous thing in the frame.
	manifest: { version: "1.2.3", description: "the npm half of the list" },
	enabledFeatures: null,
	enabled: true,
};

const marketplacePlugin: InstalledPluginSummary = {
	id: "mkt-side@catalog",
	scope: "user",
	entries: [
		{
			scope: "user",
			installPath: "/cache/marketplace/mkt-side",
			version: "0.4.2",
			installedAt: "2026-01-02T03:04:05.000Z",
			lastUpdated: "2026-02-03T04:05:06.000Z",
			enabled: true,
		},
	],
};

/**
 * A panel over one npm plugin and one marketplace plugin, in that list order, with both registries
 * stubbed. Real registries would put this suite's outcome at the mercy of the developer's own installed
 * plugins; the navigation being tested does not depend on where the entries came from.
 */
function panelOverBothKinds(): { component: PluginSettingsComponent; closes: () => number; restore: () => void } {
	const npmListSpy = spyOn(PluginManager.prototype, "list").mockResolvedValue([npmPlugin]);
	const marketplaceListSpy = spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
		marketplacePlugin,
	]);
	let closed = 0;
	const component = new PluginSettingsComponent(process.cwd(), {
		onClose: () => {
			closed++;
		},
		onPluginChanged: () => {},
	});
	return {
		component,
		closes: () => closed,
		restore: () => {
			npmListSpy.mockRestore();
			marketplaceListSpy.mockRestore();
		},
	};
}

const ENTER = "\n";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

describe("navigating the plugin settings panel", () => {
	/**
	 * The full round trip named in the bug: list, into the npm detail, back, into the marketplace detail,
	 * back. Each step asserts the view AND that the view is about the right plugin, so a transition that
	 * mounted the correct kind of view over the wrong plugin -- the failure a stale `#currentPlugin` field
	 * produces -- fails here.
	 */
	it("reports the view it is showing at every step of list -> npm detail -> marketplace detail -> back", async () => {
		const { component, restore } = panelOverBothKinds();
		try {
			await waitForView(component, "list");
			expect(textOf(component)).toContain("npm-side");
			expect(textOf(component)).toContain("mkt-side@catalog");
			expect(chipsOf(component)).toEqual([...VIEW_CHIPS.list]);

			// Entry 0 is the npm plugin.
			component.handleInput(ENTER);
			await waitForView(component, "npm-detail");
			const npmDetail = textOf(component);
			expect(npmDetail).toContain("npm-side");
			expect(npmDetail).toContain("the npm half of the list");
			// The detail view is about ONE plugin: the other entry must be gone from the frame.
			expect(npmDetail).not.toContain("mkt-side@catalog");
			expect(chipsOf(component)).toEqual([...VIEW_CHIPS["npm-detail"]]);

			component.handleInput(ESCAPE);
			await waitForView(component, "list");

			// Entry 1 is the marketplace plugin.
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await waitForView(component, "marketplace-detail");
			const marketplaceDetail = textOf(component);
			expect(marketplaceDetail).toContain("mkt-side@catalog");
			expect(marketplaceDetail).toContain("install path");
			expect(marketplaceDetail).not.toContain("npm-side");
			// The card's footer follows the view: from a detail view esc goes back
			// to the list, and the chip says so instead of "esc close".
			expect(chipsOf(component)).toEqual([...VIEW_CHIPS["marketplace-detail"]]);

			component.handleInput(ESCAPE);
			await waitForView(component, "list");
			expect(textOf(component)).toContain("npm-side");
			expect(textOf(component)).toContain("mkt-side@catalog");
			expect(chipsOf(component)).toEqual([...VIEW_CHIPS.list]);
		} finally {
			restore();
		}
	});

	/**
	 * Going into the same detail view twice must land in the same place. A panel that tracked its view in a
	 * field could get here with the field saying "list" while the detail view is mounted, at which point
	 * the second Enter is interpreted against the wrong screen.
	 */
	it("returns to the same npm detail view after going back to the list", async () => {
		const { component, restore } = panelOverBothKinds();
		try {
			await waitForView(component, "list");

			for (let round = 0; round < 3; round++) {
				component.handleInput(ENTER);
				await waitForView(component, "npm-detail");
				expect(textOf(component)).toContain("npm-side");

				component.handleInput(ESCAPE);
				await waitForView(component, "list");
			}
		} finally {
			restore();
		}
	});

	/**
	 * Escape means two different things depending on the view, and the mounted child is what decides which:
	 * from a detail view it goes back to the list, from the list it closes the panel. A panel that mounted a
	 * detail view but still routed input as if it were the list would close /settings outright, dropping the
	 * user out of the tab they were configuring.
	 */
	it("escapes to the list from a detail view and only closes the panel from the list", async () => {
		const { component, closes, restore } = panelOverBothKinds();
		try {
			await waitForView(component, "list");

			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await waitForView(component, "marketplace-detail");

			component.handleInput(ESCAPE);
			await waitForView(component, "list");
			expect(closes()).toBe(0);

			component.handleInput(ESCAPE);
			expect(closes()).toBe(1);
		} finally {
			restore();
		}
	});

	/**
	 * Selection routes by entry kind, not by position, and the two detail views are different components
	 * with different footers. Picking the marketplace entry first (rather than reaching it after the npm
	 * detour) pins that the panel is reading the entry it landed on and not remembering an earlier one.
	 */
	it("opens the marketplace detail view directly, without visiting the npm one first", async () => {
		const { component, restore } = panelOverBothKinds();
		try {
			await waitForView(component, "list");

			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await waitForView(component, "marketplace-detail");

			const text = textOf(component);
			expect(text).toContain("mkt-side@catalog");
			expect(text).toContain("[user]");
			expect(text).toContain("0.4.2");
			expect(text).not.toContain("Enable or disable this plugin");
		} finally {
			restore();
		}
	});

	/**
	 * The ambiguity check earns its keep only if it can actually see two views at once, so prove the
	 * classifier is not vacuously passing: three distinct markers exist, and a frame containing two of them
	 * is reported as a failure rather than resolved to whichever comes first.
	 */
	it("treats two simultaneously rendered views as a failure rather than picking one", () => {
		expect(new Set(Object.values(VIEW_MARKERS)).size).toBe(3);

		const bothMounted = `${VIEW_MARKERS.list}\n${VIEW_MARKERS["npm-detail"]}`;
		const fake = {
			render: () => [bothMounted],
		} as unknown as PluginSettingsComponent;

		expect(() => viewOf(fake)).toThrow(/rendered 2 views at once/);
	});
});

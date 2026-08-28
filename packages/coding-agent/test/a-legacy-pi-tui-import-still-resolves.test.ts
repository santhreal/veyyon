/**
 * WHY. `@veyyon/tui` used to re-export the string, escape and input primitives
 * from its barrel. They moved to `@veyyon/utils`, on subpaths rather than on the
 * utils barrel, and the tui barrel now re-exports none of them. That is the right
 * shape for this repository and a hard break for every extension published
 * against the old one: an `import { visibleWidth } from "@earendil-works/pi-tui"`
 * fails at import time with `Export named 'visibleWidth' not found`, which takes
 * the whole extension down rather than the one call that needed it.
 *
 * `src/extensibility/legacy-pi-tui-shim.ts` is what the bare pi-tui root resolves
 * to, and this file defends its surface. The defect class it closes is a name
 * that the old barrel served and the shim does not.
 *
 * WHAT THIS DOES NOT CATCH. The shim's completeness against the barrel as it
 * stood before the split was established by diffing that barrel, and no test can
 * re-derive it: the old barrel is in git history, not on disk, and a test that
 * shells out to `git show` fails in a source tarball. So this file pins the
 * surface two ways that do survive on disk — the shim is a strict superset of the
 * live tui barrel, and it carries every name a known third-party plugin imports —
 * and `pi-scope-aliases.test.ts` proves through the real extension loader that
 * the names come from one module instance rather than a second copy.
 */
import { describe, expect, it } from "bun:test";
import * as legacyTuiShim from "@veyyon/coding-agent/extensibility/legacy-pi-tui-shim";
import * as tui from "@veyyon/tui";

/**
 * Names third-party extensions import from the pi-tui root, each with the plugin
 * that imports it. This list is a compatibility surface, so it is pinned rather
 * than derived: what belongs on it is what somebody else already shipped against,
 * which no scan of this repository can discover. Add a row when a report names a
 * name; never remove one, because the plugin that needs it does not get updated.
 */
const LEGACY_NAMES: ReadonlyArray<readonly [string, string]> = [
	// @juicesharp/rpiv-ask-user-question — the reported break (moved to utils/width).
	["visibleWidth", "@juicesharp/rpiv-*"],
	// @plannotator/pi-extension and the rpiv-* family (moved to utils/keys).
	["Key", "plannotator, @juicesharp/rpiv-*"],
	// The renderer the root never stopped owning: a shim missing its
	// `export * from "@veyyon/tui"` would still pass every name above.
	["TUI", "every extension that draws"],
];

describe("the legacy pi-tui root", () => {
	it.each(LEGACY_NAMES)("serves %s, which %s imports", name => {
		expect(Object.keys(legacyTuiShim)).toContain(name);
	});

	/**
	 * The superset check is the part that survives a future move: whatever the tui
	 * barrel exports today, the legacy root must keep exporting, so dropping a
	 * name from the barrel without adding it to the shim turns this red.
	 */
	it("exports every name the live tui barrel exports", () => {
		const shimNames = new Set(Object.keys(legacyTuiShim));
		const missing = Object.keys(tui).filter(name => !shimNames.has(name));
		expect(
			missing,
			"names on the @veyyon/tui barrel that the legacy pi-tui root no longer serves. " +
				"Re-export them from src/extensibility/legacy-pi-tui-shim.ts: an extension " +
				"published against the old barrel imports the root, and a missing name fails " +
				"its whole import rather than one call.",
		).toEqual([]);
	});

	/**
	 * Non-vacuity twin. The superset assertion above passes trivially if either
	 * namespace reads as empty, which is what a broken specifier or a barrel that
	 * became type-only would look like.
	 */
	it("reads two real namespaces, so the superset check cannot pass on nothing", () => {
		expect(Object.keys(tui).length).toBeGreaterThan(20);
		expect(Object.keys(legacyTuiShim).length).toBeGreaterThan(Object.keys(tui).length);
	});
});

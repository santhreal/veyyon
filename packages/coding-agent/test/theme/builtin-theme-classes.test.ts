import { describe, expect, it } from "bun:test";
import { getBuiltinThemes } from "@veyyon/coding-agent/modes/theme/builtin-themes";
import {
	BUILTIN_THEME_CLASSES,
	isLightTheme,
	isLightThemeJson,
} from "@veyyon/coding-agent/modes/theme/theme-luminance";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

/**
 * Contracts: the light/dark table matches the shipped theme JSON, exactly and completely.
 *
 * WHY THIS SUITE EXISTS. `config/settings` needs one boolean for one legacy migration: an old flat
 * `theme: "<name>"` string has to land in the `theme.light` or `theme.dark` slot. It used to get that
 * boolean by importing `modes/theme/builtin-themes`, which statically embeds one JSON module per bundled
 * theme, so the settings module carried 103 modules of theme data nothing on that path reads. Because
 * roughly 1,500 test files import `Settings`, they carried it too: 33,000 module instantiations across
 * a full run for a hundred-entry lookup table.
 *
 * `theme-luminance` replaces the data with the answer. That trade is only safe if the answer cannot
 * drift from the data, which is what this file enforces: every assertion below recomputes the class
 * from the REAL theme JSON with `isLightThemeJson`, the same function that generated the table, and
 * compares. A table that disagrees, a theme added without an entry, or an entry for a theme that no
 * longer ships all fail here.
 *
 * WHAT DRIFT WOULD COST. `isLightTheme` is what places a migrated theme in the right slot and what the
 * setup wizard uses to pick a starting theme. A stale entry does not crash: it silently puts a light
 * theme in the dark slot, and the user's terminal comes up with unreadable contrast. There is no
 * runtime check that could catch it, because the table IS the runtime's answer. So the check has to be
 * here, against the JSON.
 *
 * `theme-islight.test.ts` covers the classifier's BEHAVIOUR (which surface it reads, the custom-theme
 * path on disk, the porcelain mismatch that motivated `statusLineBg`). This file covers only the
 * table's agreement with the data.
 */

const builtinThemes = getBuiltinThemes();
const themeNames = Object.keys(builtinThemes).sort();

describe("the bundled theme class table", () => {
	/** NON-VACUITY: the whole suite is a comparison, so an empty fixture would pass everything. */
	it("is measuring the hundred themes that actually ship", () => {
		expect(themeNames.length).toBeGreaterThanOrEqual(100);
		expect(themeNames).toContain("dark");
		expect(themeNames).toContain("light");
		expect(themeNames).toContain("porcelain");
	});

	/**
	 * THE CONTRACT. Recomputed from the shipped JSON, entry by entry, so the failure message names the
	 * theme that drifted rather than saying two large objects differ.
	 */
	it.each(themeNames)("classifies %s the same way its JSON does", name => {
		const themeJson = builtinThemes[name];
		expect(themeJson).toBeDefined();
		const expected = isLightThemeJson(themeJson as NonNullable<typeof themeJson>) ? "light" : "dark";

		expect(BUILTIN_THEME_CLASSES[name]).toBe(expected);
	});

	/**
	 * A new theme must not be able to ship without an entry. Without this, `BUILTIN_THEME_CLASSES[name]`
	 * returns undefined for it, `isLightTheme` takes the custom-theme branch, fails to find a file on
	 * disk, and answers "dark" for every new light theme. That is a silent wrong answer, so the missing
	 * entry has to be an error at test time.
	 */
	it("has an entry for every bundled theme, with no theme left out", () => {
		const missing = themeNames.filter(name => BUILTIN_THEME_CLASSES[name] === undefined);

		expect(missing).toEqual([]);
	});

	/**
	 * And the reverse: an entry for a theme that no longer ships. Harmless at runtime, but it means the
	 * table was edited by hand rather than regenerated, which is exactly how the drift above starts.
	 */
	it("has no entry for a theme that no longer ships", () => {
		const orphans = Object.keys(BUILTIN_THEME_CLASSES).filter(name => builtinThemes[name] === undefined);

		expect(orphans).toEqual([]);
	});

	/** Both classes are represented, so a table of all-"dark" cannot satisfy the comparisons above. */
	it("contains both light and dark themes", () => {
		const values = Object.values(BUILTIN_THEME_CLASSES);

		expect(values.filter(value => value === "light").length).toBeGreaterThan(30);
		expect(values.filter(value => value === "dark").length).toBeGreaterThan(30);
	});
});

describe("isLightTheme reads the table for bundled themes", () => {
	/**
	 * The table is consulted, not the JSON. Asserted through the public function so the fast path is
	 * proven to give the same answers the old JSON-reading implementation did.
	 */
	it.each(themeNames)("agrees with the table for %s", name => {
		expect(isLightTheme(name)).toBe(BUILTIN_THEME_CLASSES[name] === "light");
	});

	/**
	 * The two shipped defaults, spelled out because they are the ones every fresh install hits and the
	 * ones the migration's `light`/`dark` short-circuit depends on being right.
	 */
	it("classifies the two shipped defaults", () => {
		expect(isLightTheme("light")).toBe(true);
		expect(isLightTheme("dark")).toBe(false);
	});

	/**
	 * porcelain is the canonical mismatch (a dark chat bubble on an otherwise-light theme), so it is the
	 * entry that proves the table was generated from `statusLineBg` and not from `userMessageBg`. Getting
	 * this one wrong was issue #2516.
	 */
	it("keeps porcelain light, which is what fixing #2516 established", () => {
		expect(BUILTIN_THEME_CLASSES.porcelain).toBe("light");
		expect(isLightTheme("porcelain")).toBe(true);
	});

	/** No argument means the shipped default, which is dark. */
	it("treats a missing name as the dark default", () => {
		expect(isLightTheme()).toBe(false);
		expect(isLightTheme(undefined)).toBe(false);
	});

	/**
	 * An unknown name takes the custom-theme branch, finds nothing on disk, and answers dark. Dark is
	 * the shipped default and the theme's own LOAD reports the missing file with its error, so this
	 * classifier does not repeat it on every frame. Pinned so the branch cannot start throwing on a
	 * render path.
	 */
	it("answers dark for a name that is neither bundled nor on disk", () => {
		expect(isLightTheme("no-such-theme-anywhere")).toBe(false);
	});
});

describe("the table carries no theme JSON with it", () => {
	/**
	 * THE POINT OF THE SPLIT, asserted rather than trusted. `theme-luminance` must not reach
	 * `builtin-themes`, `theme`, or `config/settings`: the first puts the hundred JSON modules back on
	 * the settings graph, and the others reclose the import cycle that `builtin-themes` was carved out
	 * to break. A comment saying so is what the previous arrangement had, and it did not stop the JSON
	 * from being dragged in.
	 */
	it("imports neither the JSON table nor the theme engine nor settings", async () => {
		const source = await Bun.file(
			new URL("../../src/modes/theme/theme-luminance.ts", import.meta.url).pathname,
		).text();
		// The shared walker, not a local regex. This assertion used to carry its own copy of the pattern,
		// including the `[\s\S]*?` middle that ran a non-re-export `export` forward to the next `from` in
		// the file and swallowed every real import in between. `@veyyon/utils/module-reach` owns the
		// extraction, is tested against fixtures, and excludes `import type` and `await import()` for the
		// same reason this test wants them excluded: neither instantiates anything.
		const runtimeImports = moduleSpecifiersIn(source);

		// `node:fs`/`node:path` read a user theme from disk and cost nothing; `./color` is one module, and
		// the two utils subpaths are 19 where the barrel was 82 (`dirs` is 18 of the 19 and is unavoidable,
		// since a custom theme lives in a resolved directory). An exact list rather than a set of
		// `not.toContain`s: a new heavy import that nobody thought to forbid is the regression, and only an
		// exhaustive list catches one.
		expect(runtimeImports).toEqual(["node:fs", "node:path", "@veyyon/utils/color", "@veyyon/utils/dirs", "./color"]);
		// Named again against the resolved list, because the exhaustive check above is the kind of
		// assertion a future edit relaxes, and these five are the ones that must never come back. Checked
		// against the IMPORTS, not the source text: the module's header names them in prose, explaining why
		// it must not import them, so a text search finds them in a correct file. `@veyyon/utils` whole is
		// on the list because widening a subpath back to the barrel is the cheapest possible edit here and
		// puts 82 modules back on a classifier that runs per frame.
		for (const forbidden of ["./builtin-themes", "./theme", "./defaults", "../../config/settings", "@veyyon/utils"]) {
			expect(runtimeImports).not.toContain(forbidden);
		}
		expect(runtimeImports.filter(specifier => specifier.endsWith(".json"))).toEqual([]);
	});
});

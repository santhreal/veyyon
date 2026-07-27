/**
 * `config/settings` does not import the theme engine, and the theme settings still
 * apply live.
 *
 * WHY THIS SUITE EXISTS. Settings called `setAutoThemeMapping`, `setSymbolPreset`
 * and `setColorBlindMode` directly, so it imported `modes/theme/theme`, which
 * imports `./shimmer`, which imports `config/settings` again. A cycle is one
 * strongly connected component and has to be instantiated as a unit, so every
 * module in it cost what the whole thing cost. Measured with twenty identical test
 * files that did nothing but import one module: `config/settings` 51.4 MB per
 * file, `shimmer` 51.4, `discovery` 51.4, `theme` 51.2, all the same number
 * because they were the same component, against 15.4 for `settings-schema` just
 * outside it and 2.7 for the hundred bundled theme JSON files. The test runner
 * gives every test file a fresh realm, so a full run of the roughly 1,800 files in
 * `packages/coding-agent/test` rebuilt that component once per file and was
 * OOM-killed.
 *
 * The edge was also backwards. Settings is domain configuration, the theme engine
 * is terminal UI, and this repo's standard is that domain logic does not import
 * UI. So settings now fires a `SettingSignal` and `modes/theme/theme` subscribes
 * at its own import, which is the pattern settings already used for
 * `provider.appendOnlyContext`, `modelRoles`, `statusLine.sessionAccent` and the
 * hindsight scope.
 *
 * THEN THE COST MOVED ONE STEP OUT. Breaking the cycle left settings importing
 * `modes/theme/builtin-themes`, which statically embeds one JSON module per bundled theme. The cycle
 * was gone, but settings still dragged 103 modules of theme data for one boolean, and so did every file
 * that imports `Settings`: the reach ratchet in `test/architecture/test-suite-module-reach.test.ts`
 * measured 33,242 module instantiations across a full run. `modes/theme/theme-luminance` now owns the
 * light/dark question as a table, and settings imports that. So this suite guards two edges, not one:
 * settings must stay out of the cycle, AND out of the theme JSON.
 *
 * WHAT HAS TO STAY TRUE, and what each half of this suite checks. The structural
 * half asserts the import graph, because the behavioural half cannot see a
 * regression: re-adding a static import of the theme barrel to settings would
 * restore the cycle and the memory cost while leaving every behaviour below
 * passing. The behavioural half asserts the settings still take effect, because a
 * decoupling that quietly stopped applying `symbolPreset` would satisfy the
 * structural half perfectly.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const SETTINGS = path.join(SRC, "config", "settings.ts");
const THEME = path.join(SRC, "modes", "theme", "theme.ts");
const SHIMMER = path.join(SRC, "modes", "theme", "shimmer.ts");
const BUILTIN_THEMES = path.join(SRC, "modes", "theme", "builtin-themes.ts");
const THEME_LUMINANCE = path.join(SRC, "modes", "theme", "theme-luminance.ts");

/**
 * The theme-engine modules settings must never statically import, as EXACT specifiers.
 *
 * Matched exactly rather than by substring, and that is not a style preference. The earlier version
 * asked whether any specifier `includes("modes/theme/theme")`, which also matches
 * `modes/theme/theme-luminance`, `theme-class` and `theme-binding`. So the check reported the cycle was
 * back the moment a sibling module was named with that prefix, and it would equally have missed nothing
 * while claiming to guard something narrower than it did. A forbidden-module list says which modules
 * are forbidden.
 */
const FORBIDDEN_FROM_SETTINGS = [
	"../modes/theme/theme",
	"../modes/theme/shimmer",
	"../modes/theme/theme-class",
	// The JSON-carrying module. Not part of the cycle, but importing it costs the hundred embedded
	// theme JSON modules, which is what `theme-luminance` exists to avoid; see its header.
	"../modes/theme/builtin-themes",
] as const;

/**
 * Every module specifier this file imports with a STATIC `import`.
 *
 * THE EXTRACTION HAS ONE OWNER, `@veyyon/utils/module-reach`, and this helper is now a call to it. It was
 * three-quarters of a page of pattern with a comment listing the two things it had to get right, and it got
 * the second one wrong in the same way the owner did before it was fixed: a `[\s\S]*?` middle does not stop
 * at the end of a statement, so a non-re-export `export` ran forward to the next `from "…"` and swallowed
 * every import in between. These assertions are ABSENCES, so a swallowed import passes.
 *
 * What the owner gets right, and what this file needed: it crosses newlines (a formatter breaks a long
 * import clause across lines, and a pattern anchored on `[^;\n]` then reports the edge is gone when only
 * its formatting changed), it does not match ordinary strings, it excludes `import type` because that is
 * erased, and it excludes `await import()` because deferring is one of the two fixes this suite is about.
 * `packages/utils/test/module-reach-reads-code-not-prose.test.ts` pins all of it against fixtures.
 */
function staticImports(file: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(file, "utf-8"));
}

describe("config/settings stays out of the theme engine", () => {
	/**
	 * THE HEADLINE REGRESSION. A static import of the theme barrel from settings is
	 * what closed the cycle, and it is a one-line change to reintroduce, so the
	 * import graph is asserted directly rather than inferred from behaviour.
	 */
	it("does not statically import the theme barrel or anything else in the cycle", () => {
		const imports = staticImports(SETTINGS);

		expect(imports.filter(specifier => (FORBIDDEN_FROM_SETTINGS as readonly string[]).includes(specifier))).toEqual(
			[],
		);
	});

	/**
	 * It still reaches `isLightTheme`, from the classifier leaf. Without this the suite would pass just
	 * as well if the legacy migration below had been deleted outright, which is a different change with
	 * a different cost.
	 *
	 * `theme-luminance`, NOT `builtin-themes`, and the difference is 103 modules. `builtin-themes`
	 * breaks the import cycle but statically embeds one JSON module per bundled theme, so settings
	 * reaching through it carried theme data nothing on that path reads, and carried it again into every
	 * one of the ~1,500 test files that import `Settings`. The reach ratchet in
	 * `test/architecture/test-suite-module-reach.test.ts` measured 33,242 module instantiations of it.
	 * `theme-luminance` answers the same question from a table.
	 */
	it("reaches the light/dark classifier through the classifier leaf, not the JSON one", () => {
		const imports = staticImports(SETTINGS);

		expect(imports).toContain("../modes/theme/theme-luminance");
		expect(imports).not.toContain("../modes/theme/builtin-themes");
	});

	/**
	 * The other half of the component. `../discovery` registers fourteen capability
	 * providers, and settings needs it in exactly one already-async method, so it is
	 * a dynamic import. A static one would pull the whole registry back in.
	 */
	it("does not statically import the discovery registry", () => {
		const imports = staticImports(SETTINGS);

		expect(imports).not.toContain("../discovery");
		expect(fs.readFileSync(SETTINGS, "utf-8")).toContain('await import("../discovery")');
	});

	/**
	 * The leaf is only a leaf if it stays one. It sits below settings now, so an
	 * import of settings (or of anything that imports settings, like the theme
	 * barrel or shimmer) from inside it would rebuild the exact cycle this suite
	 * exists to prevent, with settings pointing at the leaf instead of the barrel.
	 */
	it("keeps the bundled-theme leaf free of settings, theme and shimmer", () => {
		const imports = staticImports(BUILTIN_THEMES);

		expect(imports).not.toContain("../../config/settings");
		expect(imports).not.toContain("./theme");
		expect(imports).not.toContain("./shimmer");
		expect(imports).not.toContain("./theme-class");
		// What it legitimately needs at RUNTIME, so this is not vacuously satisfied by an empty file: the
		// embedded theme data and the default table. `./color` is deliberately NOT on this list. It is the
		// only other thing the file names and it is `import type { ThemeJson }`, which is erased, costs
		// nothing, and cannot rebuild a cycle. The local pattern this helper replaced did not exclude
		// `import type`, so it reported `./color` as a runtime edge and this case asserted the phantom.
		expect(imports).toContain("./defaults");
		expect(imports).toContain("./dark.json");
		expect(imports).toContain("./light.json");
	});

	/**
	 * The classifier leaf is the one settings actually imports, so it has the stricter rule: it must
	 * stay out of the cycle AND carry no theme JSON. Importing `./defaults` or `./builtin-themes` from
	 * it would put all hundred JSON modules straight back on the settings graph while every behavioural
	 * assertion below kept passing, which is exactly the regression this half of the suite is for.
	 */
	it("keeps the classifier leaf free of the cycle and of every theme JSON", () => {
		const imports = staticImports(THEME_LUMINANCE);

		expect(imports).not.toContain("../../config/settings");
		expect(imports).not.toContain("./theme");
		expect(imports).not.toContain("./shimmer");
		expect(imports).not.toContain("./theme-class");
		expect(imports).not.toContain("./builtin-themes");
		expect(imports).not.toContain("./defaults");
		expect(imports.filter(specifier => specifier.endsWith(".json"))).toEqual([]);
		// What it legitimately needs: the colour helpers, and the disk read for a user's own theme.
		expect(imports).toContain("./color");
		expect(imports).toContain("node:fs");
	});

	/**
	 * NON-VACUITY FOR THE WHOLE STRUCTURAL HALF. Every assertion above is a
	 * `not.toContain`, and all of them would pass against files that had been
	 * emptied or renamed. This pins the edges that must still exist: shimmer really
	 * does import settings, and the theme barrel really does subscribe. If either
	 * stopped being true, the cycle would be broken for a reason this suite did not
	 * intend and the assertions above would be measuring nothing.
	 */
	it("still has the edges that made the cycle worth breaking", () => {
		// Shimmer reads settings through `config/settings-instance`, the leaf that owns the process-global
		// slot and imports nothing. That is a STRONGER version of the fact this case pins rather than a
		// weaker one: the dependency on configuration is still here, so the absences above are still
		// meaningful, and the cycle this suite exists for cannot form through shimmer at all any more,
		// because the module it now names cannot import the theme barrel back.
		expect(staticImports(SHIMMER)).toContain("../../config/settings-instance");
		expect(staticImports(SHIMMER)).not.toContain("../../config/settings");
		expect(staticImports(THEME)).toContain("../../config/settings");
	});

	/**
	 * And the direction is now one-way. Settings must not import theme; theme
	 * imports settings. Asserted as a pair so the suite states the invariant rather
	 * than two unrelated facts.
	 */
	it("points the dependency from the UI at the configuration, not the reverse", () => {
		const settingsImports = staticImports(SETTINGS);
		const themeImports = staticImports(THEME);

		expect(themeImports).toContain("../../config/settings");
		// Exact specifiers, for the reason `FORBIDDEN_FROM_SETTINGS` documents: a substring test for
		// "modes/theme/theme" also matches `theme-luminance`, the leaf settings is SUPPOSED to import.
		expect(
			settingsImports.filter(specifier => (FORBIDDEN_FROM_SETTINGS as readonly string[]).includes(specifier)),
		).toEqual([]);
	});
});

describe("the theme settings still apply when the engine is loaded", () => {
	/**
	 * Put the theme engine's ambient state back before any other suite in this process runs.
	 *
	 * WHY THIS TEARDOWN IS NOT OPTIONAL. The cases below change global rendering state on purpose --
	 * that is what they are proving -- and `currentSymbolPresetOverride` in `modes/theme/theme.ts`
	 * is module scope, so leaving it on `ascii` changes what EVERY later suite in the same process
	 * renders. That is not hypothetical: it is why
	 * `assistant-message-mermaid > aligns box borders for CJK labels` intermittently found zero rows
	 * containing box-drawing characters and read as "the renderer produced nothing". The diagram was
	 * drawn correctly, in `+` and `|`, because this file had chosen ASCII and walked away. A
	 * modes-only run passes and `test/config` plus `test/modes` reproduces, which is exactly this
	 * file's footprint.
	 *
	 * The drain before AND after matters as much as the restore. `onSymbolPresetChanged` calls an
	 * async setter without awaiting it, so the last case's write can still be in flight when
	 * teardown runs; restoring without draining first lets the stale value land afterwards, which is
	 * why the symptom looked timing-dependent rather than ordered. The restore is asserted rather
	 * than assumed, because a teardown that silently does not work is worse than none.
	 */
	afterAll(async () => {
		const themeModule = await import("@veyyon/coding-agent/modes/theme/theme");
		const { Settings } = await import("@veyyon/coding-agent/config/settings");

		await Bun.sleep(20);
		await Settings.isolated().set("symbolPreset", "unicode");
		await Bun.sleep(20);

		expect(themeModule.getSymbolPresetOverride()).toBe("unicode");
		expect(themeModule.getColorBlindMode()).toBe(false);
	});

	/**
	 * The decoupling is only correct if the setting still reaches the engine. This
	 * imports the theme module (which is what registers the subscription) and then
	 * changes the setting, which is the real operator sequence.
	 */
	it("applies symbolPreset through the signal", async () => {
		const themeModule = await import("@veyyon/coding-agent/modes/theme/theme");
		const { Settings } = await import("@veyyon/coding-agent/config/settings");
		const settings = Settings.isolated();

		await settings.set("symbolPreset", "ascii");
		// The setter is async and the hook does not await it, so let the microtask
		// queue drain before reading the applied override.
		await Bun.sleep(20);

		expect(themeModule.getSymbolPresetOverride()).toBe("ascii");
	});

	/**
	 * The same for `colorBlindMode`, which takes a different value type and a
	 * different setter, so one working does not imply the other.
	 */
	it("applies colorBlindMode through the signal", async () => {
		const themeModule = await import("@veyyon/coding-agent/modes/theme/theme");
		const { Settings } = await import("@veyyon/coding-agent/config/settings");
		const settings = Settings.isolated();

		await settings.set("colorBlindMode", true);
		await Bun.sleep(20);

		expect(themeModule.getColorBlindMode()).toBe(true);

		await settings.set("colorBlindMode", false);
		await Bun.sleep(20);

		expect(themeModule.getColorBlindMode()).toBe(false);
	});

	/**
	 * The value is persisted whether or not anyone is listening, which is the reason
	 * a missing subscriber is not a dropped update. A program that never loads the
	 * theme engine still writes the operator's choice, and the engine reads it when
	 * it loads.
	 */
	it("persists the setting independently of the signal", async () => {
		const { Settings } = await import("@veyyon/coding-agent/config/settings");
		const settings = Settings.isolated();

		await settings.set("symbolPreset", "nerd");

		expect(settings.get("symbolPreset")).toBe("nerd");
	});
});

describe("the light/dark classifier moved without changing its answers", () => {
	/**
	 * The classifier is the one piece of theme logic settings still calls, and it
	 * moved files. These pin its actual answers on the two shipped defaults, so a
	 * move that silently changed the luminance threshold or lost the theme data
	 * would fail here rather than in the legacy migration that uses it.
	 */
	it("classifies the two bundled defaults correctly", async () => {
		const { isLightTheme } = await import("@veyyon/coding-agent/modes/theme/builtin-themes");

		expect(isLightTheme("light")).toBe(true);
		expect(isLightTheme("dark")).toBe(false);
	});

	/** An unknown theme name falls to dark, which is the shipped default. */
	it("classifies an unknown theme as dark", async () => {
		const { isLightTheme } = await import("@veyyon/coding-agent/modes/theme/builtin-themes");

		expect(isLightTheme("no-such-theme-exists-here")).toBe(false);
		// Absent name means the default theme, which is dark.
		expect(isLightTheme()).toBe(false);
	});

	/**
	 * The barrel still exports it. Callers import theme lookups from
	 * `modes/theme/theme`, and the move must not have changed that public surface,
	 * so the re-export is asserted to be the SAME function rather than merely
	 * present.
	 */
	it("is still exported from the theme barrel, as the same function", async () => {
		const barrel = await import("@veyyon/coding-agent/modes/theme/theme");
		const leaf = await import("@veyyon/coding-agent/modes/theme/builtin-themes");

		expect(barrel.isLightTheme).toBe(leaf.isLightTheme);
		expect(barrel.getBuiltinThemes).toBe(leaf.getBuiltinThemes);
	});

	/**
	 * And the bundled theme set survived the move intact. `getBuiltinThemes` is what
	 * the classifier reads, so an empty or truncated record would make every lookup
	 * fall through to the dark default and still pass the two cases above.
	 */
	it("still carries the whole bundled theme set", async () => {
		const { getBuiltinThemes } = await import("@veyyon/coding-agent/modes/theme/builtin-themes");
		const themes = getBuiltinThemes();

		expect(themes.dark).toBeDefined();
		expect(themes.light).toBeDefined();
		// The `./defaults` barrel embeds one JSON file per bundled theme, and there
		// are around a hundred of them. An exact count would break every time a theme
		// is added, so this pins the order of magnitude plus a few named members.
		expect(Object.keys(themes).length).toBeGreaterThan(50);
		expect(themes["dark-gruvbox"]).toBeDefined();
		expect(themes["light-solarized"]).toBeDefined();
	});
});

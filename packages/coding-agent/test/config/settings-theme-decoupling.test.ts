/**
 * `config/settings` does not import the theme engine, and the theme settings still
 * apply live.
 *
 * WHY THIS SUITE EXISTS. Settings called `setAutoThemeMapping`, `setSymbolPreset`
 * and `setColorBlindMode` directly, so it imported `modes/theme/theme`, which
 * imports `./shimmer`, which imports `config/settings` again. A cycle is one
 * strongly connected component and has to be instantiated as a unit, so every
 * module in it pulled in the whole thing. Measured separately, `config/settings`,
 * `shimmer`, `discovery` and `theme` all reported the identical cost, which is the
 * signature: they were one component wearing four names, and reaching any of them
 * for one value loaded the entire theme engine.
 *
 * The edge was also backwards. Settings is domain configuration, the theme engine
 * is terminal UI, and this repo's standard is that domain logic does not import
 * UI. So settings now fires a `SettingSignal` and `modes/theme/theme` subscribes
 * at its own import, which is the pattern settings already used for
 * `provider.appendOnlyContext`, `modelRoles`, `statusLine.sessionAccent` and the
 * hindsight scope.
 *
 * WHAT HAS TO STAY TRUE, and what each half of this suite checks. The structural
 * half asserts the import graph, because the behavioural half cannot see a
 * regression: re-adding a static import of the theme barrel to settings would
 * restore the cycle and the memory cost while leaving every behaviour below
 * passing. The behavioural half asserts the settings still take effect, because a
 * decoupling that quietly stopped applying `symbolPreset` would satisfy the
 * structural half perfectly.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const SETTINGS = path.join(SRC, "config", "settings.ts");
const THEME = path.join(SRC, "modes", "theme", "theme.ts");
const SHIMMER = path.join(SRC, "modes", "theme", "shimmer.ts");
const BUILTIN_THEMES = path.join(SRC, "modes", "theme", "builtin-themes.ts");

/** Every module specifier this file imports with a STATIC `import`. */
function staticImports(file: string): string[] {
	const source = fs.readFileSync(file, "utf-8");
	const specifiers: string[] = [];
	// `import ... from "x"`, `import "x"`, and `export ... from "x"`. A dynamic
	// `await import("x")` is deliberately NOT matched: deferring the import is one
	// of the two fixes here, so counting it would defeat the assertions below.
	for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?["']([^"']+)["']/g)) {
		const specifier = match[1];
		if (specifier) specifiers.push(specifier);
	}
	return specifiers;
}

describe("config/settings stays out of the theme engine", () => {
	/**
	 * THE HEADLINE REGRESSION. A static import of the theme barrel from settings is
	 * what closed the cycle, and it is a one-line change to reintroduce, so the
	 * import graph is asserted directly rather than inferred from behaviour.
	 */
	it("does not statically import the theme barrel", () => {
		const imports = staticImports(SETTINGS);

		expect(imports).not.toContain("../modes/theme/theme");
		expect(imports.filter(specifier => specifier.includes("modes/theme/theme"))).toEqual([]);
	});

	/**
	 * It still reaches `isLightTheme`, from the leaf. Without this the suite would
	 * pass just as well if the legacy migration below had been deleted outright,
	 * which is a different change with a different cost.
	 */
	it("reaches the light/dark classifier through the leaf module instead", () => {
		expect(staticImports(SETTINGS)).toContain("../modes/theme/builtin-themes");
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
		// What it legitimately needs, so this is not vacuously satisfied by an empty
		// file: the colour helpers and the embedded theme data.
		expect(imports).toContain("./color");
		expect(imports).toContain("./defaults");
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
		expect(staticImports(SHIMMER)).toContain("../../config/settings");
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

		expect(themeImports.some(specifier => specifier.includes("config/settings"))).toBe(true);
		expect(settingsImports.some(specifier => specifier.includes("modes/theme/theme"))).toBe(false);
	});
});

describe("the theme settings still apply when the engine is loaded", () => {
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

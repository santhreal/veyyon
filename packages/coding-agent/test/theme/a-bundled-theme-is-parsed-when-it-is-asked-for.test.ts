/**
 * The bundled themes are embedded as text and parsed on the ask, and every shipped file is reachable
 * by name.
 *
 * WHY THIS SUITE EXISTS. `defaults/index.ts` used to import all 98 theme files with
 * `with { type: "json" }`, so a launch that resolves ONE theme built ninety-eight objects before the
 * first frame: 3.5ms of module evaluation on a 45ms card, measured on compiled binaries against an
 * empty baseline. They are now imported `with { type: "text" }` and parsed through
 * `getDefaultTheme`, which costs 1.0ms to embed and 0.08ms for the one theme a run reads.
 *
 * THE CLASS, NOT THE INCIDENT. Two ways that regresses, and both are behaviour here rather than a
 * source assertion. Drop the `type: "text"` attribute from an entry and the runtime value becomes
 * the parsed object again, so `JSON.parse` receives `[object Object]` and every lookup for that
 * theme throws: the sweep below parses EVERY shipped name, so it goes red on the first one that
 * turns back into a module. Add a theme file and forget to register it and the name resolves to
 * nothing: the name list is derived from the directory at run time, so a new file that no import
 * covers turns this red until someone adds it.
 *
 * Memoisation is asserted because callers held the old record across lookups and compared what came
 * back. A parse per call would still return equal objects and break identity quietly.
 *
 * WHAT IT DOES NOT CATCH. Whether the launch actually resolves a single theme rather than
 * enumerating them: `getBuiltinThemes()` parses the lot, and a caller that reaches for it on the
 * card path would pay the old cost with every assertion here still green. The card's own path is
 * held by `test/architecture/the-launch-card-loads-no-cold-runtime.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getBuiltinTheme,
	getBuiltinThemeNames,
	getBuiltinThemes,
	hasBuiltinTheme,
} from "@veyyon/coding-agent/theme/builtin-themes";
import { DEFAULT_THEME_NAMES, getDefaultTheme, getDefaultThemes } from "@veyyon/coding-agent/theme/defaults";

/** The shipped theme files, read from disk, so a new one joins this suite by existing. */
const SHIPPED = fs
	.readdirSync(path.join(import.meta.dir, "..", "..", "src", "theme", "defaults"))
	.filter(file => file.endsWith(".json"))
	.map(file => file.slice(0, -5))
	.sort();

describe("a bundled theme is parsed when it is asked for", () => {
	it("names every theme file that ships", () => {
		expect(SHIPPED.length).toBeGreaterThan(50);
		expect([...DEFAULT_THEME_NAMES].sort()).toEqual(SHIPPED);
	});

	it("parses every shipped theme into the theme its file names", () => {
		const failures: string[] = [];
		for (const name of SHIPPED) {
			let parsed: { name?: string } | undefined;
			try {
				parsed = getDefaultTheme(name) as { name?: string } | undefined;
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (parsed?.name !== name) failures.push(`${name}: parsed as ${String(parsed?.name)}`);
		}
		expect(failures).toEqual([]);
	});

	it("returns one object per name however often it is asked", () => {
		const first = getDefaultTheme("dark-nord");
		expect(first).toBeDefined();
		expect(getDefaultTheme("dark-nord")).toBe(first);
		expect(getBuiltinTheme("dark")).toBe(getBuiltinTheme("dark"));
	});

	it("answers for a name it does not ship without parsing anything", () => {
		expect(getDefaultTheme("no-such-theme")).toBeUndefined();
		expect(getBuiltinTheme("no-such-theme")).toBeUndefined();
		expect(hasBuiltinTheme("no-such-theme")).toBe(false);
		expect(hasBuiltinTheme("dark-nord")).toBe(true);
		expect(hasBuiltinTheme("dark")).toBe(true);
	});

	it("carries the two root themes on top of the shipped set", () => {
		expect(getBuiltinThemeNames()).toEqual(["dark", "light", ...DEFAULT_THEME_NAMES]);
		expect((getBuiltinTheme("light") as { name?: string })?.name).toBe("light");

		const all = getBuiltinThemes();
		expect(Object.keys(all).sort()).toEqual(["dark", "light", ...SHIPPED].sort());
		expect(Object.keys(getDefaultThemes()).sort()).toEqual(SHIPPED);
	});
});

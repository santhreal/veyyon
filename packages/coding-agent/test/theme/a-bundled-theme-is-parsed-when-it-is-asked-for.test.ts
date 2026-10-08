/**
 * The bundled themes are embedded as files and read and parsed on the ask, every shipped file is
 * reachable by name, and importing the table holds no theme's text.
 *
 * WHY THIS SUITE EXISTS. `defaults/index.ts` used to import all 98 theme files with
 * `with { type: "json" }`, so a launch that resolves ONE theme built ninety-eight objects before the
 * first frame: 3.5ms of module evaluation on a 45ms card, measured on compiled binaries against an
 * empty baseline. They then moved to `with { type: "text" }`, which built no object but held every
 * file's text as a module constant for the life of the process: 98 strings, 238 KiB of an idle
 * session's heap. They are now imported `with { type: "file" }`, which binds each name to the
 * asset's path, and `getDefaultTheme` reads and parses the one theme a run asks for.
 *
 * THE CLASS, NOT THE INCIDENT. Three ways that regresses, and each is behaviour here rather than a
 * source assertion. Turn an entry back into a `text` import and its text is a module constant again:
 * the heap probe imports the table in a fresh process and fails on any theme text it finds. Drop the
 * attribute from an entry and the runtime value becomes the parsed object, so the read receives an
 * object for a path and every lookup for that theme throws: the sweep below parses EVERY shipped
 * name, so it goes red on the first one that turns back into a module. Add a theme file and forget
 * to register it and the name resolves to nothing: the name list is derived from the directory at
 * run time, so a new file that no import covers turns this red until someone adds it.
 *
 * Memoisation is asserted because callers held the old record across lookups and compared what came
 * back. A parse per call would still return equal objects and break identity quietly.
 *
 * A name that is a key of `Object.prototype` is not a theme. The tables are object literals, so a
 * bare index or `in` answered `toString` with a function and `hasBuiltinTheme` called it shipped.
 *
 * WHAT IT DOES NOT CATCH. Whether the launch actually resolves a single theme rather than
 * enumerating them: `getBuiltinThemes()` parses the lot, and a caller that reaches for it on the
 * card path would pay the old cost with every assertion here still green. The card's own path is
 * held by `test/architecture/the-launch-card-loads-no-cold-runtime.test.ts`. The probe runs the
 * source tree, not the compiled binary, so it does not see how the bundler embeds the assets.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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

	it("ships no theme named for an Object.prototype member", () => {
		const failures: string[] = [];
		for (const name of Object.getOwnPropertyNames(Object.prototype)) {
			try {
				if (getDefaultTheme(name) !== undefined) failures.push(`getDefaultTheme(${name})`);
				if (getBuiltinTheme(name) !== undefined) failures.push(`getBuiltinTheme(${name})`);
				if (hasBuiltinTheme(name)) failures.push(`hasBuiltinTheme(${name})`);
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("holds no theme's text once the table is imported and one theme is read", () => {
		const probe = spawnSync(process.execPath, ["-e", HEAP_PROBE], {
			cwd: path.join(import.meta.dirname, "..", ".."),
			encoding: "utf8",
		});
		expect(probe.stderr).toBe("");
		expect(JSON.parse(probe.stdout)).toEqual({ parsed: "dark-nord", themeTexts: [] });
	});

	it("carries the two root themes on top of the shipped set", () => {
		expect(getBuiltinThemeNames()).toEqual(["dark", "light", ...DEFAULT_THEME_NAMES]);
		expect((getBuiltinTheme("light") as { name?: string })?.name).toBe("light");

		const all = getBuiltinThemes();
		expect(Object.keys(all).sort()).toEqual(["dark", "light", ...SHIPPED].sort());
		expect(Object.keys(getDefaultThemes()).sort()).toEqual(SHIPPED);
	});
});

/**
 * Imports the table in a fresh process, reads one theme, collects, and lists every heap string that
 * is a shipped theme file's text: a JSON object whose `name`, after an optional `$schema` line, is a
 * shipped theme. `Bun.generateHeapSnapshot` is the measurement; no `node:*` call lists heap strings.
 */
const HEAP_PROBE = `
const { DEFAULT_THEME_NAMES, getDefaultTheme } = await import("@veyyon/coding-agent/theme/defaults");
const { getBuiltinTheme } = await import("@veyyon/coding-agent/theme/builtin-themes");
const parsed = getDefaultTheme("dark-nord").name;
getBuiltinTheme("dark");
Bun.gc(true);
const shipped = new Set(["dark", "light", ...DEFAULT_THEME_NAMES]);
const snap = JSON.parse(Bun.generateHeapSnapshot("v8"));
const fields = snap.snapshot.meta.node_fields;
const stride = fields.length;
const typeAt = fields.indexOf("type");
const nameAt = fields.indexOf("name");
const stringType = snap.snapshot.meta.node_types[0].indexOf("string");
const themeTexts = [];
for (let i = 0; i < snap.nodes.length; i += stride) {
	if (snap.nodes[i + typeAt] !== stringType) continue;
	const value = snap.strings[snap.nodes[i + nameAt]];
	const theme = /^\\{\\s*(?:"\\$schema":[^\\n]*\\s*)?"name":\\s*"([^"]+)"/.exec(value);
	if (theme && shipped.has(theme[1])) themeTexts.push(theme[1]);
}
process.stdout.write(JSON.stringify({ parsed, themeTexts }));
`;

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { theme as themeFromEngine } from "@veyyon/coding-agent/modes/theme/theme";
import { setActiveTheme, theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme-class";

const BINDING = path.join(import.meta.dir, "../../src/modes/theme/theme-binding.ts");

/**
 * `theme` is a mutable module-level binding that the theme engine reassigns when a
 * theme loads, and every reader sees the new value because ES module bindings are
 * live. Moving it out of `modes/theme/theme` into a leaf is only safe if that
 * stays true, and it is exactly the kind of thing that breaks silently: a reader
 * left holding the first theme forever still renders, just in the wrong colours.
 *
 * The move happened so that reading the active theme does not require importing
 * the 108-module engine. `session/agent-session` imported the engine for one
 * getter on its null-object UI adapter.
 */
describe("the active theme binding stays live", () => {
	/**
	 * Publish probes, then put the real theme back.
	 *
	 * The probes below are deliberately NOT themes -- `{ name: "first-probe" }` has no colours, no
	 * symbols and no `spinnerFrames` -- because the contract under test is only that the binding
	 * forwards whatever was published. But the binding is process-global and every renderer in the
	 * process reads it, so leaving a probe installed hands a themeless object to whatever renders next.
	 *
	 * That is not hypothetical: leaving one installed made 12 tests in three unrelated suites
	 * (session-manager migration, large-session memory guards, eval/idle-timeout) fail with
	 * `TypeError: undefined is not an object (evaluating 'theme.spinnerFrames.length')` from a
	 * `ToolExecution` spinner interval still ticking every 80ms, reported by bun as an unhandled error
	 * between tests and blamed on whichever test happened to be running. Restoring the previous value
	 * costs one line and keeps this suite's blast radius inside this suite.
	 */
	let previousTheme: Theme;

	beforeEach(() => {
		previousTheme = theme;
	});

	afterEach(() => {
		setActiveTheme(previousTheme);
	});

	/**
	 * The contract in one case. Read through the module binding AFTER a
	 * reassignment, not through a value captured before it, and the new theme must
	 * come back. A `const` snapshot or a re-exported copy would fail here.
	 */
	it("reports a theme published after import", () => {
		const first = { name: "first-probe" } as unknown as Theme;
		const second = { name: "second-probe" } as unknown as Theme;

		setActiveTheme(first);
		expect(theme).toBe(first);

		setActiveTheme(second);
		expect(theme).toBe(second);
		expect(theme).not.toBe(first);
	});

	/**
	 * The engine re-exports the binding, because `modes/theme/theme` has always been
	 * where callers import `theme` from and 149 modules still do. That re-export
	 * must forward the SAME live binding, not a copy taken at load: if it copied,
	 * every one of those callers would silently stop seeing theme changes while the
	 * few that switched to the leaf kept working, which is the worst possible split.
	 */
	it("shows the same value through the engine's re-export", () => {
		const published = { name: "reexport-probe" } as unknown as Theme;

		setActiveTheme(published);

		expect(themeFromEngine).toBe(published);
		expect(themeFromEngine).toBe(theme);
	});

	/**
	 * The point of the split. The leaf must import nothing at runtime, or a reader
	 * pays for whatever it pulls in and the engine is back in front of everyone.
	 * Only `import type` is allowed, since it is erased.
	 *
	 * Read as text rather than through the module graph so a `type` import that
	 * later loses its `type` keyword is caught here too.
	 */
	it("imports nothing at runtime", () => {
		const source = fs.readFileSync(BINDING, "utf8");
		const runtimeImports = source
			.split("\n")
			.filter(line => /^\s*(?:import|export)\b.*\bfrom\b/.test(line))
			.filter(line => !/^\s*import\s+type\b/.test(line));

		expect(runtimeImports).toEqual([]);
	});

	/**
	 * Anti-vacuity for the case above: the filter must still catch a real runtime
	 * import, and must not catch the type-only one the file legitimately has.
	 */
	it("would catch a runtime import, and still allows the type import", () => {
		const classify = (line: string) =>
			/^\s*(?:import|export)\b.*\bfrom\b/.test(line) && !/^\s*import\s+type\b/.test(line);

		expect(classify('import { theme } from "./theme";')).toBe(true);
		expect(classify('export { x } from "./y";')).toBe(true);
		expect(classify('import type { Theme } from "./theme-class";')).toBe(false);
	});
});

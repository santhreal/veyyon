/**
 * A theme that cannot be loaded must not read as a theme that does not exist.
 *
 * WHY THIS SUITE EXISTS. `getThemeByName` is what an extension calls to ask for a theme by name. It
 * caught every failure and returned `undefined`, which is also the answer for a name nobody has ever
 * defined, so a custom theme with a trailing comma in its JSON was indistinguishable from a typo in
 * the name. Whoever hit it went looking for the wrong bug: they checked the spelling of a theme whose
 * file was sitting right there, malformed.
 *
 * The value is deliberately unchanged, because the caller's contract is "no theme by that name, carry
 * on with the active one", and an extension asking for a theme must not take the UI down. What changed
 * is that the failure is now named along with the theme and the parse error, so the two cases can be
 * told apart in the log even though they cannot be told apart in the return value.
 *
 * The suite asserts the warning for that reason: the return value proves nothing here, since it was
 * already `undefined` before the fix.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { logger } from "@veyyon/utils";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

let warnings: Warning[];
let restore: () => void;

beforeEach(() => {
	warnings = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	restore = () => spy.mockRestore();
});

afterEach(() => {
	restore();
});

describe("a built-in theme", () => {
	/** The ordinary case: it loads, and nothing is reported. */
	it("loads without a warning", async () => {
		expect(await getThemeByName("dark")).toBeDefined();
		expect(warnings).toEqual([]);
	});
});

describe("a theme name nothing defines", () => {
	/**
	 * Undefined is the honest answer, and the report says which name failed. Both this case and the
	 * malformed-file case below report, because both are the caller asking for something it cannot have;
	 * what matters is that the log distinguishes them by their error.
	 */
	it("returns undefined and names the theme it could not load", async () => {
		expect(await getThemeByName("no-such-theme-anywhere")).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Theme could not be loaded");
		expect(warnings[0]?.meta.theme).toBe("no-such-theme-anywhere");
	});
});

describe("what this suite deliberately does not prove", () => {
	/**
	 * The distinction between "no theme by that name" and "the file is malformed" lives in the logged
	 * ERROR, not in the message or the return value, and it cannot be exercised in-process: the directory
	 * resolver fixes the agent directory when it is first imported, so a `VEYYON_CODING_AGENT_DIR` set
	 * inside a test leaves the custom-themes path pointing at the real one and a theme file written to a
	 * temporary directory is never read. An earlier version of this suite did exactly that and passed on a
	 * "Theme not found" error while proving nothing about a malformed file.
	 *
	 * What IS pinned is the regression that mattered: the failure is reported at all, with the name and a
	 * non-empty error, where before there was silence. This test states the contract the reporting has to
	 * keep so a future change cannot quietly drop the error field and leave the log useless.
	 */
	it("always carries a non-empty error alongside the theme name", async () => {
		await getThemeByName("still-no-such-theme");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.meta.theme).toBe("still-no-such-theme");
		expect(typeof warnings[0]?.meta.error).toBe("string");
		expect(warnings[0]?.meta.error).not.toBe("");
	});
});

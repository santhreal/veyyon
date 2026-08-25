/**
 * `resolvePersonality("none")` is the disable sentinel and returns an empty
 * block without touching disk. The comparison is `=== NONE_PERSONALITY`, so
 * `"None"` and `"NONE"` are ordinary names: they fall through to unknown and
 * inject the default spec with a warning.
 *
 * tag-breakout-variants-and-truncation-cut.test.ts already pins `None.md` as
 * a filename that cannot register. This file pins the REQUESTED NAME, which
 * is a different hop: a settings value of `None` must not silently disable
 * the block the way `none` does.
 */
import { describe, expect, it } from "bun:test";
import {
	NONE_PERSONALITY,
	resolvePersonality,
} from "@veyyon/coding-agent/personality/resolver";
import { useTempHome } from "../helpers/temp-home";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeProject = useTrackedTempDirs("pi-personality-none-case-");
useTempHome("test");

describe("the none sentinel is exact, not case-folded", () => {
	it("returns an empty block for lowercase none", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality(NONE_PERSONALITY, { cwd });
		expect(resolved.name).toBe("none");
		expect(resolved.text).toBe("");
		expect(resolved.warning).toBeUndefined();
	});

	it("does not treat 'None' as the disable sentinel", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality("None", { cwd });
		expect(resolved.name).not.toBe("none");
		expect(resolved.text).not.toBe("");
		expect(resolved.warning).toMatch(/Unknown personality "None"/);
	});

	it("does not treat 'NONE' as the disable sentinel", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality("NONE", { cwd });
		expect(resolved.name).not.toBe("none");
		expect(resolved.text).not.toBe("");
		expect(resolved.warning).toMatch(/Unknown personality "NONE"/);
	});

	it("does not treat ' none ' as the disable sentinel (no trim on the request)", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality(" none ", { cwd });
		expect(resolved.name).not.toBe("none");
		expect(resolved.text).not.toBe("");
	});
});

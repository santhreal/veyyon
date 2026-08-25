/**
 * project-beats-user already pins `resolvePersonality("None")` is not the
 * disable sentinel. These two neighbors are not in that file: the request
 * is not case-folded (`NONE`) and is not trimmed (` none `).
 */
import { describe, expect, it } from "bun:test";
import { resolvePersonality } from "@veyyon/coding-agent/personality/resolver";
import { useTempHome } from "../helpers/temp-home";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeProject = useTrackedTempDirs("pi-personality-none-case-");
useTempHome("test");

describe("the none sentinel is not case-folded or trimmed", () => {
	it("does not treat NONE as the disable sentinel", async () => {
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

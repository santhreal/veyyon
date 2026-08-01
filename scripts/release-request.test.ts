import { describe, expect, it } from "bun:test";
import { parseReleaseRequest } from "./release";

describe("release version argument", () => {
	/** A bare version argument is the patch release the Release workflow defaults to. */
	it("defaults to a patch release", () => {
		expect(parseReleaseRequest([])).toBe("patch");
	});

	/** Operators can choose every version form accepted by the remote workflow. */
	it("accepts named bumps and exact versions", () => {
		for (const version of ["major", "minor", "patch", "2.4.0"]) {
			expect(parseReleaseRequest([version])).toBe(version);
		}
	});

	/** Ambiguous or malformed input must fail before any GitHub action is attempted. */
	it("rejects malformed and additional version arguments", () => {
		expect(() => parseReleaseRequest(["v2.4.0"])).toThrow("Invalid release version");
		expect(() => parseReleaseRequest(["2.4"])).toThrow("Invalid release version");
		expect(() => parseReleaseRequest(["patch", "minor"])).toThrow("accepts one version");
	});
});

describe("workflow-internal cutter boundary", () => {
	/** Direct local invocation must stop before release.ts can mutate, commit, tag, or push the tree. */
	it("refuses to run the cutter outside the Release workflow", async () => {
		const process = Bun.spawn(["bun", "scripts/release.ts", "workflow-release", "patch"], {
			env: { ...Bun.env, VEYYON_RELEASE_IN_CI: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("workflow-release may run only inside Release CI");
	});
});

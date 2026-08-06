import { describe, expect, it } from "bun:test";
import { parseReleaseRequest } from "./release";

describe("release version argument", () => {
	/** A bare version argument is the patch release `bun run release:prepare` defaults to. */
	it("defaults to a patch release", () => {
		expect(parseReleaseRequest([])).toBe("patch");
	});

	/** Operators can choose every version form the preparation script accepts. */
	it("accepts named bumps and exact versions", () => {
		for (const version of ["major", "minor", "patch", "2.4.0"]) {
			expect(parseReleaseRequest([version])).toBe(version);
		}
	});

	/** Ambiguous or malformed input must fail before the tree is touched. */
	it("rejects malformed and additional version arguments", () => {
		expect(() => parseReleaseRequest(["v2.4.0"])).toThrow("Invalid release version");
		expect(() => parseReleaseRequest(["2.4"])).toThrow("Invalid release version");
		expect(() => parseReleaseRequest(["patch", "minor"])).toThrow("accepts one version");
	});
});

describe("release.ts is no longer a cutter", () => {
	/**
	 * The version cut moved to `scripts/prerelease.ts`, which runs on an operator's
	 * machine and commits nothing but the bump. What is left in `release.ts` for CI
	 * is verification, so every mutating subcommand the old controller exposed must
	 * be gone rather than merely unreachable — a lingering `workflow-release` would
	 * be a second, ungated way to mutate, commit, tag and push the tree.
	 */
	it("rejects every subcommand of the removed release controller", async () => {
		for (const command of ["workflow-release", "workflow-gate", "release", "train"]) {
			const process = Bun.spawn(["bun", "scripts/release.ts", command, "patch"], {
				env: { ...Bun.env, VEYYON_RELEASE_IN_CI: "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Usage: release.ts verify-tag");
		}
	});
});

import { describe, expect, it } from "bun:test";
import {
	hasRequiredActiveGitHubAccount,
	parseReleaseRequest,
	type ReleaseTriggerOperations,
	triggerRelease,
} from "./release";

function operations(overrides: Partial<ReleaseTriggerOperations> = {}): {
	operations: ReleaseTriggerOperations;
	events: string[];
} {
	const events: string[] = [];
	return {
		events,
		operations: {
			currentBranch: async () => {
				events.push("branch");
				return "main";
			},
			workingTreeStatus: async () => {
				events.push("status");
				return "";
			},
			fetchMain: async () => {
				events.push("fetch");
			},
			localHead: async () => {
				events.push("local-head");
				return "approved-sha";
			},
			originMainHead: async () => {
				events.push("remote-head");
				return "approved-sha";
			},
			authStatus: async () => {
				events.push("auth");
				return "✓ Logged in to github.com account santhsecurity (keyring)\n  - Active account: true";
			},
			dispatch: async (version, expectedSha) => {
				events.push(`dispatch:${version}:${expectedSha}`);
			},
			...overrides,
		},
	};
}

describe("operator release request", () => {
	/** A bare command is the one-step patch-release path rather than a usage failure. */
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

describe("release trigger safety boundary", () => {
	/** The command dispatches only after local main, origin/main, and the required identity agree. */
	it("dispatches the requested workflow for the exact synchronized main SHA", async () => {
		const fixture = operations();

		expect(await triggerRelease("minor", fixture.operations)).toEqual({ version: "minor", sha: "approved-sha" });
		expect(fixture.events).toEqual([
			"branch",
			"status",
			"fetch",
			"local-head",
			"remote-head",
			"auth",
			"dispatch:minor:approved-sha",
		]);
	});

	/** A feature branch must never be mistaken for the main release candidate. */
	it("refuses a non-main checkout before fetching or dispatching", async () => {
		const fixture = operations({ currentBranch: async () => "feature" });

		await expect(triggerRelease("patch", fixture.operations)).rejects.toThrow('checkout is on "feature"');
		expect(fixture.events).toEqual([]);
	});

	/** Uncommitted bytes are not represented by the remote workflow and must not appear to ship. */
	it("refuses a dirty working tree before fetching or dispatching", async () => {
		const fixture = operations({ workingTreeStatus: async () => " M packages/ai/src/auth-storage.ts\n" });

		await expect(triggerRelease("patch", fixture.operations)).rejects.toThrow("clean working tree");
		expect(fixture.events).toEqual(["branch"]);
	});

	/** A local-only or remote-only commit lacks one shared release identity and must stop the command. */
	it("refuses when local main and origin main name different commits", async () => {
		const fixture = operations({ originMainHead: async () => "newer-remote-sha" });

		await expect(triggerRelease("patch", fixture.operations)).rejects.toThrow("does not match origin/main");
		expect(fixture.events).not.toContain("dispatch:patch:newer-remote-sha");
	});

	/** Public release actions must never run through one of the workstation's unrelated GitHub accounts. */
	it("requires santhsecurity to be the active gh login", async () => {
		const fixture = operations({
			authStatus: async () =>
				"✓ Logged in to github.com account santhsecurity (keyring)\n  - Active account: false\n" +
				"✓ Logged in to github.com account another-user (keyring)\n  - Active account: true",
		});

		await expect(triggerRelease("patch", fixture.operations)).rejects.toThrow("santhsecurity must be active");
		expect(fixture.events).not.toContain("dispatch:patch:approved-sha");
	});

	/** The status parser must bind the active marker to its own account block, not a later account. */
	it("recognizes the required active account without accepting a cross-account marker", () => {
		expect(
			hasRequiredActiveGitHubAccount(
				"✓ Logged in to github.com account santhsecurity (keyring)\n  - Active account: true",
			),
		).toBe(true);
		expect(
			hasRequiredActiveGitHubAccount(
				"✓ Logged in to github.com account santhsecurity (keyring)\n  - Active account: false\n" +
					"✓ Logged in to github.com account anionicsanth (keyring)\n  - Active account: true",
			),
		).toBe(false);
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

/**
 * The source-install update contract: `veyyon update` (and everything routed
 * through `installRelease`) updates a source checkout by fast-forwarding it and
 * reinstalling dependencies, in that order, and fails closed with the manual
 * recovery on any step failure.
 *
 * Why this suite exists: the updater used to REFUSE source installs with
 * advice ("run git pull"), which stranded a real user (2026-07-24) on a stale
 * checkout — and even following the advice broke boot, because `git pull`
 * without the dependency reinstall leaves gitignored build artifacts
 * (tool-views.generated.js) missing. The updater owning BOTH steps is the fix;
 * these tests pin the step sequence, the failure surfaces, and the reporter
 * output so the contract cannot silently regress into advice again.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type CheckoutVersionReader,
	SOURCE_VERSION_FILE,
	type SourceUpdateExec,
	updateViaSourceAt,
} from "@veyyon/coding-agent/cli/update-cli";

const LAUNCHER = path.join("/opt/checkout", "packages", "coding-agent", "scripts", "veyyon");

/** A checkout that ends up at exactly the version the update asked for. */
const readsVersion =
	(version: string | undefined): CheckoutVersionReader =>
	async () =>
		version;

function recordingExec(failOnLabel?: string): {
	calls: { label: string; command: string[]; cwd: string }[];
	exec: SourceUpdateExec;
} {
	const calls: { label: string; command: string[]; cwd: string }[] = [];
	const exec: SourceUpdateExec = async step => {
		calls.push({ label: step.label, command: step.command, cwd: step.cwd });
		if (step.label === failOnLabel) return { exitCode: 128, stderr: "fatal: not a git repository" };
		return { exitCode: 0, stderr: "" };
	};
	return { calls, exec };
}

describe("updateViaSourceAt (source-install update steps)", () => {
	it("runs fetch, ff-only merge, then bun install — all in the checkout root", async () => {
		const { calls, exec } = recordingExec();
		const reported: string[] = [];
		await updateViaSourceAt(LAUNCHER, "2.0.0", line => reported.push(line), exec, readsVersion("2.0.0"));

		expect(calls.map(c => c.command.join(" "))).toEqual([
			"git fetch --tags origin",
			"git merge --ff-only @{u}",
			"bun install",
			// Explicit regen: Bun runs no root lifecycle scripts on workspace
			// installs, so `bun install` alone leaves gitignored build artifacts
			// stale or missing.
			"bun --cwd=packages/collab-web run gen:tool-views",
			// The addon is version-sentinel-checked at boot: an advanced checkout
			// with the previous release's addon dies like a missing one, so the
			// update must provision a current addon (see ensure-native.ts).
			"bun --cwd=packages/natives run ensure",
		]);
		// launcher/../../../.. resolves to the checkout root the steps run in.
		for (const call of calls) expect(path.resolve(call.cwd)).toBe("/opt/checkout");
		expect(reported.some(line => line.includes("Updated source checkout to 2.0.0"))).toBe(true);
	});

	/** A diverged branch must fail closed (never force-resolve a user's working
	 * tree) and the error must carry the manual recovery command. */
	it("stops at a failing ff-only merge with the manual guidance, skipping bun install", async () => {
		const { calls, exec } = recordingExec("Fast-forwarding checkout");

		await expect(updateViaSourceAt(LAUNCHER, "2.0.0", () => {}, exec)).rejects.toThrow(
			/git merge --ff-only.*exited 128.*git pull && bun install/s,
		);
		expect(calls.map(c => c.label)).toEqual(["Fetching", "Fast-forwarding checkout"]);
	});

	/** The dependency reinstall is NOT optional: a pulled checkout without it
	 * can fail to boot (gitignored generated artifacts). Its failure must be as
	 * loud as a git failure. */
	it("surfaces a bun install failure with the step's stderr", async () => {
		const { exec } = recordingExec("Installing dependencies");

		await expect(updateViaSourceAt(LAUNCHER, "2.0.0", () => {}, exec)).rejects.toThrow(
			/Installing dependencies failed.*not a git repository/s,
		);
	});
});

/**
 * Every step exiting 0 proves the commands ran, not that the checkout reached
 * the release. `git merge --ff-only @{u}` fast-forwards to whatever the branch
 * TRACKS: a user on a feature branch, or on a fork whose upstream lags, gets a
 * successful merge and stays behind. The updater used to print "Updated source
 * checkout to 2.0.0" over exactly that state — the silent wrong-version success
 * the installers' doctor gate already closes for binary installs.
 */
describe("updateViaSourceAt verifies the checkout actually reached the release", () => {
	it("reads the version back from the checkout after the steps run", async () => {
		const seen: string[] = [];
		const { exec } = recordingExec();
		await updateViaSourceAt(
			LAUNCHER,
			"2.0.0",
			() => {},
			exec,
			async root => {
				seen.push(root);
				return "2.0.0";
			},
		);
		// It must read the checkout it just updated, not the running process's own
		// installation directory.
		expect(seen).toHaveLength(1);
		expect(path.resolve(seen[0] as string)).toBe("/opt/checkout");
	});

	it("refuses to claim the new version when the checkout is still behind", async () => {
		const reported: string[] = [];
		const { exec } = recordingExec();

		await expect(
			updateViaSourceAt(LAUNCHER, "2.0.0", line => reported.push(line), exec, readsVersion("1.9.3")),
		).rejects.toThrow(/is at 1\.9\.3, not 2\.0\.0/);
		// And the success line must not have been printed anyway.
		expect(reported.some(line => line.includes("Updated source checkout to"))).toBe(false);
	});

	it("names the likely cause and the manual recovery in the mismatch error", async () => {
		// "wrong version" alone leaves the user with no next move; the branch not
		// tracking the release branch is the actual cause in nearly every case.
		const { exec } = recordingExec();
		await expect(updateViaSourceAt(LAUNCHER, "2.0.0", () => {}, exec, readsVersion("1.9.3"))).rejects.toThrow(
			/does not track the branch.*git pull && bun install/s,
		);
	});

	it("treats an unreadable version as failure, never as agreement", async () => {
		// Law 10: a check that could not run has not passed. Swallowing the read
		// error and reporting success would reintroduce the bug through the back
		// door, on the checkouts most likely to be broken.
		const { exec } = recordingExec();
		await expect(updateViaSourceAt(LAUNCHER, "2.0.0", () => {}, exec, readsVersion(undefined))).rejects.toThrow(
			new RegExp(`Could not read ${SOURCE_VERSION_FILE.replace(/[./]/g, "\\$&")}.*unverified`, "s"),
		);
	});

	it("verifies only after every step, so a half-updated checkout cannot pass", async () => {
		// Reading the version before `bun install`/regen would see the right number
		// on a checkout that is not yet runnable.
		const order: string[] = [];
		const exec: SourceUpdateExec = async step => {
			order.push(step.label);
			return { exitCode: 0, stderr: "" };
		};
		await updateViaSourceAt(
			LAUNCHER,
			"2.0.0",
			() => {},
			exec,
			async () => {
				order.push("version-read");
				return "2.0.0";
			},
		);
		expect(order[order.length - 1]).toBe("version-read");
	});

	it("does not read the version at all when a step already failed", async () => {
		// The steps' own error is the actionable one; a version mismatch report on
		// top of it would misdirect the user to a branch problem they do not have.
		let reads = 0;
		const { exec } = recordingExec("Fast-forwarding checkout");
		await expect(
			updateViaSourceAt(
				LAUNCHER,
				"2.0.0",
				() => {},
				exec,
				async () => {
					reads += 1;
					return "1.9.3";
				},
			),
		).rejects.toThrow(/git merge --ff-only/);
		expect(reads).toBe(0);
	});
});

describe("the checkout's version comes from one declared file", () => {
	it("SOURCE_VERSION_FILE points at the manifest the CLI is built from", () => {
		expect(SOURCE_VERSION_FILE).toBe("packages/coding-agent/package.json");
	});

	it("that file really carries a semver version field", async () => {
		// If the manifest were ever restructured, the reader would start returning
		// undefined and every source update would fail closed with a confusing
		// message. This fails first, and points at why.
		const raw = await Bun.file(new URL("../package.json", import.meta.url)).text();
		expect((JSON.parse(raw) as { version?: unknown }).version).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("source launcher self-heal (scripts/veyyon)", () => {
	/** The launcher is the last line of defense for a checkout whose gitignored
	 * tool-views.generated.js is missing (bare `git pull`, fresh clone): Bun
	 * resolves that text import at parse time, so without this guard veyyon
	 * dies at boot with a raw ResolveMessage. The guard must regenerate when
	 * absent and fail closed with the exact fix when it cannot. */
	it("guards the missing tool-views artifact before exec, with regen and a fail-closed fix", async () => {
		const launcher = await Bun.file(new URL("../scripts/veyyon", import.meta.url)).text();
		expect(launcher).toContain("tool-views.generated.js");
		expect(launcher).toContain('if [ ! -f "$tool_views" ]');
		expect(launcher).toContain("run gen:tool-views");
		expect(launcher).toContain("bun install");
		// The guard sits before the exec lines, not after (an exec never returns).
		expect(launcher.indexOf('if [ ! -f "$tool_views" ]')).toBeLessThan(launcher.indexOf("exec bun"));
	});
});

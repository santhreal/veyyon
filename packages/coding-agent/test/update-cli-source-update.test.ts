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
import { type SourceUpdateExec, updateViaSourceAt } from "@veyyon/coding-agent/cli/update-cli";

const LAUNCHER = path.join("/opt/checkout", "packages", "coding-agent", "scripts", "veyyon");

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
		await updateViaSourceAt(LAUNCHER, "2.0.0", line => reported.push(line), exec);

		expect(calls.map(c => c.command.join(" "))).toEqual([
			"git fetch --tags origin",
			"git merge --ff-only @{u}",
			"bun install",
			// Explicit regen: Bun runs no root lifecycle scripts on workspace
			// installs, so `bun install` alone leaves gitignored build artifacts
			// stale or missing.
			"bun --cwd=packages/collab-web run gen:tool-views",
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

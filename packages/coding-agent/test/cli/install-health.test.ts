/**
 * The install half of `veyyon setup status`.
 *
 * `install.sh` proves an install works at the end of every install: the binary
 * runs, it reports the version the release claims, its native addon loads, and
 * the command resolves on PATH. That evidence existed exactly once. A user whose
 * veyyon stopped working a week later could not ask any of it again, and the
 * health check that did exist answered a different question: it looked `veyyon`
 * up on PATH and reported "Found at <path>" without ever running it, so a binary
 * that could not execute — a `noexec` mount, a release built for the wrong
 * platform, a truncated download — was counted as ok.
 *
 * Every case here asserts the status AND the sentence, because the sentence is
 * the whole product: "Native addon: error" with no reason sends the reader
 * nowhere.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type InstallHealthDeps,
	runInstallHealthChecks,
	veyyonPathEntries,
} from "@veyyon/coding-agent/cli/install-health";

const BIN = "/home/u/.local/bin/veyyon";

/** A machine where everything is right, which each case then breaks one way. */
function healthyDeps(overrides: InstallHealthDeps = {}): InstallHealthDeps {
	return {
		resolveBinary: () => BIN,
		resolveAlias: () => "/home/u/.local/bin/vey",
		pathValue: "/home/u/.local/bin:/usr/bin",
		exists: filePath => filePath === BIN || filePath.includes("bash-completion"),
		version: "9.9.9",
		verifyVersion: async () => ({ ok: true, actual: "9.9.9", path: BIN }),
		probeSearch: async () => undefined,
		env: { HOME: "/home/u", PATH: "/home/u/.local/bin:/usr/bin" },
		...overrides,
	};
}

function find(checks: Array<{ name: string; status: string; message: string }>, name: string) {
	const check = checks.find(c => c.name === name);
	expect(check).toBeDefined();
	return check as { name: string; status: string; message: string };
}

describe("veyyonPathEntries finds every copy that could shadow the one being updated", () => {
	it("returns the directories holding a veyyon, in PATH order", () => {
		const entries = veyyonPathEntries(
			["/a", "/b", "/c"].join(path.delimiter),
			filePath => filePath === "/a/veyyon" || filePath === "/c/veyyon",
		);
		expect(entries).toEqual(["/a/veyyon", "/c/veyyon"]);
	});

	/**
	 * PATH order IS the answer: the first entry is what the shell runs, and an
	 * update that writes the second one leaves the user with an unchanged version
	 * and no explanation. Sorting or de-duplicating by basename would destroy that.
	 */
	it("keeps PATH order rather than sorting", () => {
		const entries = veyyonPathEntries("/z:/a", filePath => filePath.endsWith("/veyyon"));
		expect(entries).toEqual(["/z/veyyon", "/a/veyyon"]);
	});

	it("counts a directory listed twice only once", () => {
		// A duplicated PATH entry is common (a login shell that sourced its rc
		// twice) and is not two installs. Reporting it as shadowing would send the
		// user hunting for a second copy that does not exist.
		const entries = veyyonPathEntries("/a:/a", filePath => filePath === "/a/veyyon");
		expect(entries).toEqual(["/a/veyyon"]);
	});

	it("finds the Windows names as well as the POSIX one", () => {
		expect(veyyonPathEntries("/a", filePath => filePath === "/a/veyyon.exe")).toEqual(["/a/veyyon.exe"]);
		expect(veyyonPathEntries("/a", filePath => filePath === "/a/veyyon.cmd")).toEqual(["/a/veyyon.cmd"]);
	});

	it("answers nothing for an empty or unset PATH instead of throwing", () => {
		expect(veyyonPathEntries(undefined)).toEqual([]);
		expect(veyyonPathEntries("")).toEqual([]);
	});
});

describe("runInstallHealthChecks on a healthy install", () => {
	it("reports every check ok and names the path and version", async () => {
		const checks = await runInstallHealthChecks(healthyDeps());

		expect(checks.every(check => check.status === "ok")).toBe(true);
		expect(find(checks, "veyyon on PATH").message).toContain(BIN);
		expect(find(checks, "veyyon runs").message).toContain("9.9.9");
		expect(find(checks, "Native addon").message).toContain("search");
		expect(find(checks, "PATH copies").message).toContain("One copy");
	});

	it("says which way this install updates", async () => {
		const binary = await runInstallHealthChecks(healthyDeps());
		expect(find(binary, "Install method").message).toContain("Release binary");

		const launcher = "/home/u/.veyyon/src/packages/coding-agent/scripts/veyyon";
		const source = await runInstallHealthChecks(
			healthyDeps({ resolveBinary: () => launcher, exists: filePath => filePath === launcher }),
		);
		expect(find(source, "Install method").message).toContain("Source checkout");
	});
});

describe("runInstallHealthChecks on a broken install", () => {
	/**
	 * The failure the old check could not see. `$which` finds the file, so the
	 * name resolves; running it is the only thing that proves anything, and the
	 * reason the binary gives has to reach the reader verbatim or they are told
	 * "something is wrong" and nothing else.
	 */
	it("reports a binary that will not run as an error, with the binary's own reason", async () => {
		const checks = await runInstallHealthChecks(
			healthyDeps({
				verifyVersion: async () => ({
					ok: false,
					path: BIN,
					reason: `${BIN} exited 126 when asked for its version. It said: cannot execute binary file`,
				}),
			}),
		);

		const check = find(checks, "veyyon runs");
		expect(check.status).toBe("error");
		expect(check.message).toContain("exited 126");
		expect(check.message).toContain("cannot execute binary file");
	});

	/**
	 * A version mismatch is NOT the binary being broken: the file is fine and PATH
	 * is resolving a different one. Calling it an error would send the user to
	 * reinstall a binary that has nothing wrong with it, so it is a warning that
	 * names both versions and says what is actually happening.
	 */
	it("reports a version mismatch as shadowing, not as a broken binary", async () => {
		const checks = await runInstallHealthChecks(
			healthyDeps({ verifyVersion: async () => ({ ok: false, actual: "1.0.0", path: BIN }) }),
		);

		const check = find(checks, "veyyon runs");
		expect(check.status).toBe("warning");
		expect(check.message).toContain("1.0.0");
		expect(check.message).toContain("9.9.9");
		expect(check.message).toContain("PATH");
	});

	/**
	 * `--version` is answered by the entry point alone, so a release built for the
	 * wrong platform passes it and fails on the first real command. This is the
	 * check that catches it, and it must carry the probe's explanation rather than
	 * a status of its own.
	 */
	it("reports a native addon that does not load, with the probe's explanation", async () => {
		const checks = await runInstallHealthChecks(
			healthyDeps({ probeSearch: async () => "veyyon cannot run a search (`grep` exited 1)" }),
		);

		const check = find(checks, "Native addon");
		expect(check.status).toBe("error");
		expect(check.message).toContain("cannot run a search");
	});

	it("names every copy on PATH when more than one exists", async () => {
		const checks = await runInstallHealthChecks(
			healthyDeps({
				pathValue: "/usr/local/bin:/home/u/.local/bin",
				exists: filePath => filePath === "/usr/local/bin/veyyon" || filePath === BIN,
			}),
		);

		const check = find(checks, "PATH copies");
		expect(check.status).toBe("warning");
		expect(check.message).toContain("/usr/local/bin/veyyon");
		expect(check.message).toContain(BIN);
		expect(check.message).toContain("first one wins");
	});

	/**
	 * Nothing to ask questions about. Returning the one error and stopping is the
	 * point: every check after this one is about a specific file, and running them
	 * against a path that does not exist would produce four more failures that all
	 * say the same thing.
	 */
	it("stops at the first check when nothing resolves on PATH", async () => {
		const checks = await runInstallHealthChecks(healthyDeps({ resolveBinary: () => undefined }));

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("error");
		expect(checks[0]?.message).toContain("does not resolve on PATH");
	});

	/**
	 * Completions are the one part of an install that fails without saying
	 * anything: nothing errors, Tab simply stops offering anything, and there is
	 * no message anywhere to explain it. A warning is the right level because the
	 * CLI still works perfectly without them.
	 */
	it("warns when no completion file is installed and says how to get them", async () => {
		const checks = await runInstallHealthChecks(healthyDeps({ exists: filePath => filePath === BIN }));

		const check = find(checks, "Shell completions");
		expect(check.status).toBe("warning");
		expect(check.message).toContain("completions");
	});
});

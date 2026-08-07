/**
 * The source-install update contract: `veyyon update` (and everything routed
 * through `installRelease`) updates a source checkout by fast-forwarding it and
 * reinstalling dependencies, in that order, and fails closed with the manual
 * recovery on any step failure.
 *
 * Why this suite exists: the updater used to REFUSE source installs with
 * advice ("run git pull"), which stranded a source install on a stale
 * checkout — and even following the advice broke boot, because `git pull`
 * without the dependency reinstall leaves gitignored build artifacts
 * (tool-views.generated.js) missing. The updater owning BOTH steps is the fix;
 * these tests pin the step sequence, the failure surfaces, and the reporter
 * output so the contract cannot silently regress into advice again.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CheckoutVersionReader,
	probeSearchWorks,
	type SearchProbe,
	SOURCE_VERSION_FILE,
	type SourceUpdateExec,
	updateViaSourceAt,
} from "@veyyon/coding-agent/cli/update-cli";
import { enterTempHome, type TempHome } from "./helpers/temp-home";

// A completed update refreshes the shell completions it finds under HOME. With
// the real HOME that is the developer's own dotfiles, which these tests have no
// business reading, let alone rewriting.
let tempHome: TempHome;
beforeAll(() => {
	tempHome = enterTempHome();
});
afterAll(() => {
	tempHome.restore();
});

const LAUNCHER = path.join("/opt/checkout", "packages", "coding-agent", "scripts", "veyyon");

/**
 * A checkout that runs. These are unit tests of the step sequence against a
 * launcher path that does not exist on disk, so the real probe (which refuses a
 * launcher it cannot execute) is injected out. Its own behavior is covered in
 * the suite below.
 */
const checkoutRuns: SearchProbe = async () => undefined;

/** A checkout that ends up at exactly the version the update asked for. */
const readsVersion =
	(version: string | undefined): CheckoutVersionReader =>
	async () =>
		version;

const PREVIOUS_REVISION = "1".repeat(40);

function recordingExec(failOnLabel?: string): {
	calls: { label: string; command: string[]; cwd: string }[];
	exec: SourceUpdateExec;
} {
	const calls: { label: string; command: string[]; cwd: string }[] = [];
	const exec: SourceUpdateExec = async step => {
		calls.push({ label: step.label, command: step.command, cwd: step.cwd });
		if (step.label === failOnLabel) {
			return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
		}
		if (step.label === "Recording current revision") {
			return { exitCode: 0, stdout: PREVIOUS_REVISION, stderr: "" };
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	return { calls, exec };
}

describe("updateViaSourceAt (source-install update steps)", () => {
	it("runs fetch, ff-only merge, then bun install — all in the checkout root", async () => {
		const { calls, exec } = recordingExec();
		const reported: string[] = [];
		await updateViaSourceAt(
			LAUNCHER,
			"2.0.0",
			line => reported.push(line),
			exec,
			readsVersion("2.0.0"),
			checkoutRuns,
		);

		expect(calls.map(c => c.command.join(" "))).toEqual([
			"git status --porcelain --untracked-files=no",
			"git rev-parse --verify HEAD",
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
		expect(calls.map(c => c.label)).toEqual([
			"Checking source checkout",
			"Recording current revision",
			"Fetching",
			"Fast-forwarding checkout",
		]);
	});

	/** The dependency reinstall is NOT optional: a pulled checkout without it
	 * can fail to boot (gitignored generated artifacts). Its failure must be as
	 * loud as a git failure. */
	it("restores the previous revision when dependency installation fails after the merge", async () => {
		const { calls, exec } = recordingExec("Installing dependencies");

		await expect(
			updateViaSourceAt(LAUNCHER, "2.0.0", () => {}, exec, readsVersion("2.0.0"), checkoutRuns),
		).rejects.toThrow(/Installing dependencies failed.*Restored the previous source revision 111111111111/s);
		expect(calls.map(call => call.label)).toEqual([
			"Checking source checkout",
			"Recording current revision",
			"Fetching",
			"Fast-forwarding checkout",
			"Installing dependencies",
			"Restoring previous revision",
			"Restoring dependencies",
			"Restoring build artifacts",
			"Restoring native addon",
		]);
	});

	it("refuses a dirty tracked checkout before fetching or recording a rollback point", async () => {
		const { calls, exec: baseExec } = recordingExec();
		const exec: SourceUpdateExec = async step => {
			const result = await baseExec(step);
			return step.label === "Checking source checkout"
				? { ...result, stdout: " M packages/coding-agent/package.json" }
				: result;
		};

		await expect(updateViaSourceAt(LAUNCHER, "2.0.0", () => {}, exec)).rejects.toThrow(
			/has tracked or staged changes.*Nothing was changed|has tracked or staged changes/s,
		);
		expect(calls.map(call => call.label)).toEqual(["Checking source checkout"]);
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
			checkoutRuns,
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
			return {
				exitCode: 0,
				stdout: step.label === "Recording current revision" ? PREVIOUS_REVISION : "",
				stderr: "",
			};
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
			checkoutRuns,
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

/**
 * A version file says what the checkout claims, not that it runs.
 *
 * Every step of the update can exit 0 and still leave a checkout that does not
 * work: `bun install` can land a partial tree, the regen step writes an
 * artifact nobody has loaded yet, and `natives ensure` stages an addon it never
 * dlopens. The binary path proves the install functions by running a real
 * search; a source install is a first-class consumer path and gets the same
 * proof, from the same {@link probeSearchWorks} owner.
 */
describe("updateViaSourceAt proves the checkout actually runs", () => {
	it("fails the update when the checkout cannot run a search", async () => {
		const { exec } = recordingExec();
		await expect(
			updateViaSourceAt(
				LAUNCHER,
				"2.0.0",
				() => {},
				exec,
				readsVersion("2.0.0"),
				async () => "its native addon did not load",
			),
		).rejects.toThrow(/its native addon did not load/);
	});

	it("gives the manual recovery with that failure, as every other source failure does", async () => {
		// A user told only that the checkout is broken has no next move.
		const { exec } = recordingExec();
		await expect(
			updateViaSourceAt(
				LAUNCHER,
				"2.0.0",
				() => {},
				exec,
				readsVersion("2.0.0"),
				async () => "broken",
			),
		).rejects.toThrow(/git pull && bun install/);
	});

	it("never claims success when the probe failed", async () => {
		const reported: string[] = [];
		const { exec } = recordingExec();
		await expect(
			updateViaSourceAt(
				LAUNCHER,
				"2.0.0",
				l => reported.push(l),
				exec,
				readsVersion("2.0.0"),
				async () => "broken",
			),
		).rejects.toThrow();
		expect(reported.some(l => l.includes("Updated source checkout to"))).toBe(false);
	});

	it("probes the launcher the installer put on PATH, and names the checkout in the label", async () => {
		// Probing anything else would verify a different install than the one the
		// user launches, and a label without the path leaves the error ambiguous
		// for someone with more than one checkout.
		const { exec } = recordingExec();
		const seen: { bin: string; label: string }[] = [];
		await updateViaSourceAt(
			LAUNCHER,
			"2.0.0",
			() => {},
			exec,
			readsVersion("2.0.0"),
			async (bin, label) => {
				seen.push({ bin, label });
				return undefined;
			},
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.bin).toBe(LAUNCHER);
		expect(seen[0]?.label).toContain("/opt/checkout");
		expect(seen[0]?.label).toContain("2.0.0");
	});

	it("probes the restored checkout after a version mismatch", async () => {
		// The new checkout is not probed after the version mismatch. Recovery
		// resets first, then the shared probe proves the previous install still runs.
		const { exec } = recordingExec();
		let probes = 0;
		await expect(
			updateViaSourceAt(
				LAUNCHER,
				"2.0.0",
				() => {},
				exec,
				readsVersion("1.9.3"),
				async () => {
					probes += 1;
					return undefined;
				},
			),
		).rejects.toThrow(/is at 1\.9\.3/);
		expect(probes).toBe(1);
	});

	it("probes after every step, never against a half-updated checkout", async () => {
		const order: string[] = [];
		const exec: SourceUpdateExec = async step => {
			order.push(step.label);
			return {
				exitCode: 0,
				stdout: step.label === "Recording current revision" ? PREVIOUS_REVISION : "",
				stderr: "",
			};
		};
		await updateViaSourceAt(
			LAUNCHER,
			"2.0.0",
			() => {},
			exec,
			readsVersion("2.0.0"),
			async () => {
				order.push("probe");
				return undefined;
			},
		);
		expect(order[order.length - 1]).toBe("probe");
		expect(order).toContain("Ensuring native addon");
	});
});

/**
 * The probe itself. It is the one owner shared with the binary swap, so a hole
 * here is a hole in both consumer update paths at once.
 */
describe("probeSearchWorks", () => {
	it("refuses a launcher that is missing, rather than excusing it", async () => {
		// The hole this closes: Bun's shell reports a missing command as exit 1,
		// the same code an unknown subcommand produces, and the "this build has no
		// grep" excuse would have passed a checkout with no launcher at all.
		const reason = await probeSearchWorks("/opt/checkout/definitely/not/here", "The checkout");
		expect(reason).toContain("missing or not executable");
		expect(reason).toContain("/opt/checkout/definitely/not/here");
	});

	it("refuses a launcher that exists and is not executable", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-probe-"));
		const bin = path.join(dir, "veyyon");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
		try {
			expect(await probeSearchWorks(bin, "The checkout")).toContain("missing or not executable");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes an install whose search finds the file it was pointed at", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-probe-"));
		const bin = path.join(dir, "veyyon");
		fs.writeFileSync(
			bin,
			'#!/bin/sh\n[ "$2" = "--help" ] && exit 0\nshift\nprintf "%s/probe.txt:1: %s\\n" "$2" "$1"\n',
			{ mode: 0o755 },
		);
		try {
			expect(await probeSearchWorks(bin, "The checkout")).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	/**
	 * The "this build predates `grep`" excuse, and the failure it used to swallow.
	 *
	 * A failing `grep --help` was read as "an older release that has no such
	 * subcommand" from the exit code alone. That is also exactly what a binary
	 * whose native addon fails to load on any real subcommand produces — the
	 * precise failure this probe exists to catch — so the probe answered "works"
	 * and the update kept a binary that cannot do anything (Law 10). The excuse now
	 * has to survive a second question: can the binary answer its own top-level
	 * `--help`? An old release can; a broken install cannot.
	 */
	it("excuses a build with no grep subcommand only when its own --help still works", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-probe-"));
		const bin = path.join(dir, "veyyon");
		// An older release: `grep` is not a command it knows, everything else is fine.
		fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = "grep" ] && { echo "unknown command" >&2; exit 1; }\nexit 0\n', {
			mode: 0o755,
		});
		try {
			expect(await probeSearchWorks(bin, "The checkout")).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a binary that fails grep --help and fails --help too", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-probe-"));
		const bin = path.join(dir, "veyyon");
		// A broken install: the addon fails to load, so every subcommand dies the
		// same way. Under the old exit-code-only reading this passed as "an old
		// build" and the update was kept.
		fs.writeFileSync(bin, '#!/bin/sh\necho "failed to load native addon" >&2\nexit 1\n', { mode: 0o755 });
		try {
			const reason = await probeSearchWorks(bin, "The checkout");
			expect(reason).toContain("the install is broken");
			expect(reason).toContain("failed to load native addon");
			expect(reason).toContain("The checkout");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	/**
	 * The excuse must not cost a spawn on the ordinary path. A working install
	 * answers `grep --help` on the first try, so the disambiguating `--help` run
	 * never happens and every update check stays at two spawns, not three.
	 */
	it("does not ask for --help when grep --help already succeeded", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-probe-"));
		const bin = path.join(dir, "veyyon");
		const log = path.join(dir, "invocations.log");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho "$*" >> ${log}\n[ "$2" = "--help" ] && exit 0\nshift\nprintf "%s/probe.txt:1: %s\\n" "$2" "$1"\n`,
			{ mode: 0o755 },
		);
		try {
			expect(await probeSearchWorks(bin, "The checkout")).toBeUndefined();
			const invocations = fs.readFileSync(log, "utf8").trim().split("\n");
			expect(invocations[0]).toBe("grep --help");
			expect(invocations.some(line => line === "--help")).toBe(false);
			expect(invocations).toHaveLength(2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

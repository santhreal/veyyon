/**
 * WHY: every browser without a named profile runs on a temporary `veyyon-chrome-profile-*` directory
 * under the system temp directory, removed when its browser is disposed. A process that crashed or was
 * killed never disposed it, and nothing else removed it: each leaked profile kept a whole Chromium
 * profile (cache, IndexedDB, cookies of the sites it visited) on disk until the host's own temp cleanup,
 * which many hosts never run.
 *
 * The class: a temporary profile kept after its owner is gone, or one removed while something still
 * uses it. Each case plants a profile beside the one `createProfile` makes and checks the sweep that
 * runs first: removed only when its owner file names a process on this host that no longer runs and
 * no running Chromium holds its lock; kept when the owner runs, is on another host, is missing or
 * unreadable as a pid, when a live Chromium holds it, or when the directory is not a temporary profile.
 *
 * Not caught: the Windows lock (`lockfile` held open), which these cases plant only as Linux's
 * symlink; two hosts with one hostname sharing a temp directory across pid namespaces, where a pid
 * that runs in the other namespace reads as gone here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProfile } from "@veyyon/coding-agent/tools/web/browser/profiles";
import { TempDir } from "@veyyon/utils";

/** The largest pid Linux hands out by default: no process holds it in a test container. */
const GONE_PID = 4_194_303;

interface Planted {
	/** The owner file's text, or `null` for a profile with no owner file. */
	readonly owner: string | null;
	/** The target of a `SingletonLock` symlink in the profile, if any. */
	readonly lock?: string;
	readonly name?: string;
	readonly kept: boolean;
}

const host = os.hostname();
const CASES: Record<string, Planted> = {
	"an owner on this host that no longer runs": { owner: `${host}-${GONE_PID}`, kept: false },
	"an owner on this host that runs": { owner: `${host}-${process.pid}`, kept: true },
	"an owner on another host": { owner: `another-host-${GONE_PID}`, kept: true },
	"no owner file": { owner: null, kept: true },
	"an owner that names no pid": { owner: `${host}-x`, kept: true },
	"a gone owner whose profile a running Chromium holds": {
		owner: `${host}-${GONE_PID}`,
		lock: `${host}-${process.pid}`,
		kept: true,
	},
	"a gone owner whose profile's lock names a gone Chromium": {
		owner: `${host}-${GONE_PID}`,
		lock: `${host}-${GONE_PID}`,
		kept: false,
	},
	"a directory that is not a temporary profile": { owner: `${host}-${GONE_PID}`, name: "other-profile-x", kept: true },
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a temporary browser profile", () => {
	for (const [label, planted] of Object.entries(CASES)) {
		// The planted lock is the `SingletonLock` symlink; Windows locks by holding `lockfile` open.
		it.skipIf(planted.lock !== undefined && process.platform === "win32")(
			`with ${label} is ${planted.kept ? "kept" : "removed"} when the next one is made`,
			async () => {
				await using parent = await TempDir.create("@veyyon-profile-sweep-");
				const dir = parent.join(planted.name ?? "veyyon-chrome-profile-planted");
				fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
				if (planted.owner !== null) fs.writeFileSync(path.join(dir, "veyyon-owner"), planted.owner);
				if (planted.lock) fs.symlinkSync(planted.lock, path.join(dir, "SingletonLock"));
				vi.spyOn(os, "tmpdir").mockReturnValue(parent.path());

				const made = await createProfile();

				expect(fs.existsSync(dir)).toBe(planted.kept);
				expect(path.dirname(made)).toBe(parent.path());
				expect(fs.readFileSync(path.join(made, "veyyon-owner"), "utf8")).toBe(`${host}-${process.pid}`);
			},
		);
	}

	it("made by this process is kept by the sweep the next one runs", async () => {
		await using parent = await TempDir.create("@veyyon-profile-sweep-own-");
		vi.spyOn(os, "tmpdir").mockReturnValue(parent.path());
		const first = await createProfile();
		const second = await createProfile();
		expect(fs.existsSync(first)).toBe(true);
		expect(fs.existsSync(second)).toBe(true);
	});
});

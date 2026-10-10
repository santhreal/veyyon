/**
 * WHY: every launch without a named profile first sweeps the system temp directory for
 * `veyyon-chrome-profile-*` directories a dead process left behind, reading the owner file inside each.
 * The temp directory is shared by every user of the host, and `mkdtemp` makes each profile mode 0700,
 * so the owner file of another user's profile cannot be read. The sweep threw that read error out of
 * `createProfile`, and no browser could start for anyone else while one user had a browser open, or had
 * left a profile behind; any local user could block every other user's browser by planting a directory
 * under the prefix.
 *
 * The class: an entry under the prefix whose owner file exists but cannot be read stops the sweep, and
 * with it the launch. Each case plants one such entry beside a profile a gone process left, and checks
 * that `createProfile` still makes its profile, keeps the unreadable entry, and goes on to remove the
 * gone process's profile, so the sweep is not abandoned at the first entry it cannot read.
 *
 * Not caught: an entry that cannot be listed or locked on Windows, whose temp directory is per user;
 * the permission case, when the suite runs as root, which reads through any mode.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProfile } from "@veyyon/coding-agent/tools/web/browser/profiles";
import { TempDir } from "@veyyon/utils";

/** The largest pid Linux hands out by default: no process holds it in a test container. */
const GONE_PID = 4_194_303;

const host = os.hostname();
const runsAsRoot = process.getuid?.() === 0;

interface Unreadable {
	/** Plant, in profile directory `dir`, an owner file a read of fails. */
	readonly plant: (dir: string) => void;
	/** Undo whatever stops the temp directory's own removal. */
	readonly restore?: (dir: string) => void;
	readonly skip?: boolean;
}

const CASES: Record<string, Unreadable> = {
	"another user's profile, whose directory this process cannot enter": {
		plant: dir => {
			fs.writeFileSync(path.join(dir, "veyyon-owner"), `${host}-${GONE_PID}`);
			fs.chmodSync(dir, 0o000);
		},
		restore: dir => fs.chmodSync(dir, 0o700),
		// Root reads through any mode; Windows has no POSIX mode bits to deny with.
		skip: runsAsRoot || process.platform === "win32",
	},
	"an owner path that is a directory": {
		plant: dir => fs.mkdirSync(path.join(dir, "veyyon-owner")),
	},
	"an owner path that is a symlink loop": {
		plant: dir => fs.symlinkSync("veyyon-owner", path.join(dir, "veyyon-owner")),
		skip: process.platform === "win32",
	},
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a temporary browser profile whose owner this process cannot read", () => {
	for (const [label, unreadable] of Object.entries(CASES)) {
		it.skipIf(unreadable.skip === true)(`(${label}) is kept, and the launch and the sweep go on`, async () => {
			await using parent = await TempDir.create("@veyyon-profile-sweep-unreadable-");
			// Beside a profile a gone process left: a launch that fails on the unreadable entry fails in either
			// listing order, and one that stops sweeping at it leaves the other whenever it is listed first.
			const blocked = parent.join("veyyon-chrome-profile-a-unreadable");
			const orphan = parent.join("veyyon-chrome-profile-b-orphan");
			fs.mkdirSync(blocked);
			fs.mkdirSync(path.join(orphan, "Default"), { recursive: true });
			fs.writeFileSync(path.join(orphan, "veyyon-owner"), `${host}-${GONE_PID}`);
			unreadable.plant(blocked);
			vi.spyOn(os, "tmpdir").mockReturnValue(parent.path());
			try {
				const made = await createProfile();

				expect(fs.readFileSync(path.join(made, "veyyon-owner"), "utf8")).toBe(`${host}-${process.pid}`);
				expect(fs.existsSync(blocked)).toBe(true);
				expect(fs.existsSync(orphan)).toBe(false);
			} finally {
				unreadable.restore?.(blocked);
			}
		});
	}
});

/**
 * `veyyon rollback` as an operator uses it.
 *
 * The command is the only place a person names a version by hand, so the tests
 * concentrate on the two moments that go wrong there: a version that does not
 * exist (a typo, or a half-remembered number), and a listing that has to tell
 * you where you currently stand before you can choose anything at all.
 *
 * The installer is injected, so "selecting 1.1.0 installs 1.1.0" is asserted as
 * the exact version handed to the installer rather than inferred from output
 * text. A rollback test that only checked the printed message would pass while
 * installing the wrong release.
 */
import { describe, expect, it } from "bun:test";
import {
	buildRollbackRows,
	formatRollbackList,
	type RollbackDeps,
	runRollbackCommand,
} from "@veyyon/coding-agent/cli/rollback-cli";
import type { ReleaseListing, UpdateHistoryEntry } from "@veyyon/coding-agent/cli/update-cli";

const RELEASES: ReleaseListing[] = [
	{ tag: "v1.3.0", version: "1.3.0", publishedAt: "2026-07-01T00:00:00Z" },
	{ tag: "v1.2.0", version: "1.2.0", publishedAt: "2026-06-01T00:00:00Z" },
	{ tag: "v1.1.0", version: "1.1.0", publishedAt: "2026-05-01T00:00:00Z" },
];

function deps(overrides: Partial<RollbackDeps> = {}): RollbackDeps & { installed: string[] } {
	const installed: string[] = [];
	return {
		listReleases: async () => RELEASES,
		rollback: async version => {
			installed.push(version);
		},
		history: async () => [],
		currentVersion: "1.2.0",
		installed,
		...overrides,
	};
}

describe("rollback --list", () => {
	it("lists every published version with its date", async () => {
		const { output, exitCode } = await runRollbackCommand({ list: true }, deps());

		expect(exitCode).toBe(0);
		for (const version of ["1.3.0", "1.2.0", "1.1.0"]) expect(output).toContain(version);
		expect(output).toContain("2026-05-01");
	});

	it("marks the running version, so the list answers where you are", async () => {
		// Without it the list is a set of numbers with no anchor, and the first
		// question anybody has ("which one am I on?") needs a second command.
		const { output } = await runRollbackCommand({ list: true }, deps());

		expect(output).toMatch(/1\.2\.0.*\(current\)/);
	});

	it("marks a version newer than the running one as a move forward", async () => {
		// Rolling "back" to something newer is legitimate (you pinned an old
		// version, then want out), but it must not be presented as going back.
		const { output } = await runRollbackCommand({ list: true }, deps());

		expect(output).toMatch(/1\.3\.0.*\(newer\)/);
	});

	it("marks a version the history says you ran before", async () => {
		const moves: UpdateHistoryEntry[] = [{ from: "1.1.0", to: "1.2.0", at: "2026-06-02T00:00:00Z" }];
		const { output } = await runRollbackCommand({ list: true }, deps({ history: async () => moves }));

		expect(output).toMatch(/1\.1\.0.*previously run/);
	});

	it("emits JSON with the changelog URL per row", async () => {
		const { output } = await runRollbackCommand({ list: true, json: true }, deps());
		const rows = JSON.parse(output) as { version: string; changelogUrl: string }[];

		expect(rows[0]).toMatchObject({ version: "1.3.0", changelogUrl: "https://veyyon.dev/changelog#v1-3-0" });
	});

	it("lists rather than doing nothing when no version is given", async () => {
		// The bare non-interactive form must still be useful; exiting silently
		// would look like a command that ran and failed.
		const { output, exitCode } = await runRollbackCommand({}, deps());

		expect(exitCode).toBe(0);
		expect(output).toContain("1.1.0");
	});
});

describe("rollback <version>", () => {
	it("installs exactly the version named", async () => {
		const d = deps();
		const { exitCode } = await runRollbackCommand({ version: "1.1.0" }, d);

		expect(exitCode).toBe(0);
		expect(d.installed).toEqual(["1.1.0"]);
	});

	it("accepts a v-prefixed version, which is how tags are written", async () => {
		const d = deps();
		await runRollbackCommand({ version: "v1.1.0" }, d);

		expect(d.installed).toEqual(["1.1.0"]);
	});

	it("prints that version's changelog link on success", async () => {
		const { output } = await runRollbackCommand({ version: "1.1.0" }, deps());

		expect(output).toContain("https://veyyon.dev/changelog#v1-1-0");
	});

	it("rejects an unpublished version and names real ones", async () => {
		// The reason somebody types a version is that they half-remember it, so the
		// rejection has to show the candidates rather than only say no.
		const d = deps();
		const { output, exitCode } = await runRollbackCommand({ version: "1.1.5" }, d);

		expect(exitCode).toBe(1);
		expect(output).toContain("1.1.5");
		expect(output).toContain("1.3.0");
		expect(d.installed).toEqual([]);
	});

	it("does not install anything when the version is unknown", async () => {
		const d = deps();
		await runRollbackCommand({ version: "9.9.9" }, d);

		expect(d.installed).toEqual([]);
	});

	it("surfaces an installer failure as a non-zero exit with the reason", async () => {
		// A rollback that fails and exits 0 leaves you on the old version believing
		// you moved, which is the single worst outcome this command has.
		const d = deps({
			rollback: async () => {
				throw new Error("This is a source install");
			},
		});
		const { output, exitCode } = await runRollbackCommand({ version: "1.1.0" }, d);

		expect(exitCode).toBe(1);
		expect(output).toContain("This is a source install");
	});

	it("fails loudly when the release list cannot be read", async () => {
		// Never an empty picker: "offline" and "no versions exist" must not look the
		// same.
		const { output, exitCode } = await runRollbackCommand(
			{ list: true },
			deps({
				listReleases: async () => {
					throw new Error("HTTP 500 Server Error");
				},
			}),
		);

		expect(exitCode).toBe(1);
		expect(output).toContain("HTTP 500 Server Error");
	});
});

describe("the bare form", () => {
	it("opens the picker when the caller supplies one", async () => {
		const d = deps({ pickVersion: async () => "1.1.0" });
		const { exitCode } = await runRollbackCommand({}, d);

		expect(exitCode).toBe(0);
		expect(d.installed).toEqual(["1.1.0"]);
	});

	it("hands the picker every row, markers and all", async () => {
		// The picker draws current/newer/previously-run from these; passing it a
		// bare version list would silently strip every marker.
		let seen: readonly { version: string; current: boolean }[] = [];
		await runRollbackCommand(
			{},
			deps({
				pickVersion: async rows => {
					seen = rows;
					return null;
				},
			}),
		);

		expect(seen.map(row => row.version)).toEqual(["1.3.0", "1.2.0", "1.1.0"]);
		expect(seen.find(row => row.current)?.version).toBe("1.2.0");
	});

	it("installs nothing when the picker is cancelled", async () => {
		const d = deps({ pickVersion: async () => null });
		const { exitCode } = await runRollbackCommand({}, d);

		expect(exitCode).toBe(0);
		expect(d.installed).toEqual([]);
	});

	it("prints the list instead when there is no picker, rather than doing nothing", async () => {
		// The non-TTY path. Blocking on a keypress nobody can send would hang a
		// script; printing nothing would look like a command that failed silently.
		const { output, exitCode } = await runRollbackCommand({}, deps());

		expect(exitCode).toBe(0);
		expect(output).toContain("1.1.0");
	});

	it("surfaces an install failure chosen through the picker", async () => {
		// The picker path must not be the one place a failed install exits 0.
		const d = deps({
			pickVersion: async () => "1.1.0",
			rollback: async () => {
				throw new Error("download failed");
			},
		});
		const { output, exitCode } = await runRollbackCommand({}, d);

		expect(exitCode).toBe(1);
		expect(output).toContain("download failed");
	});
});

describe("buildRollbackRows", () => {
	it("treats both ends of a recorded move as previously run", async () => {
		// You ran the version you left as much as the one you arrived at; marking
		// only arrivals leaves the version you want back unmarked.
		const rows = buildRollbackRows(RELEASES, "1.2.0", [{ from: "1.3.0", to: "1.2.0", at: "2026-07-02T00:00:00Z" }]);

		expect(rows.find(row => row.version === "1.3.0")?.visited).toBe(true);
	});

	it("never marks the running version as a rollback target", () => {
		const rows = buildRollbackRows(RELEASES, "1.2.0");

		expect(rows.filter(row => row.current).map(row => row.version)).toEqual(["1.2.0"]);
	});

	it("renders a row with no publish date rather than dropping it", () => {
		// A release whose timestamp is missing is still installable, and hiding it
		// would silently shorten the catalog.
		const rows = buildRollbackRows([{ tag: "v1.0.0", version: "1.0.0" }], "1.2.0");

		expect(formatRollbackList(rows)).toContain("1.0.0");
	});
});

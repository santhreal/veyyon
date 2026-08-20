import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Every line `veyyon update` prints must print with no theme loaded.
 *
 * THE DEFECT. `theme` is `export var theme: Theme` in `modes/theme/theme-binding.ts`
 * and holds `undefined` until `initTheme()` assigns it. The update path formatted
 * two of its messages straight off it — the success line after a completed swap and
 * "Already up to date" — so a caller that drives the update flow without loading a
 * theme died with `Cannot read properties of undefined (reading 'status')`. The
 * success line is the worse of the two by far: it runs AFTER the binary has been
 * replaced, verified and the backup reclaimed, so the throw reports a finished
 * update as a failed one and invites a caller to retry a swap that already happened.
 * The shipped CLI loads a theme before dispatch and never saw it; an SDK embedder
 * and a test child both reach it on the first try, and one of this repo's own update
 * suites had to call `initTheme()` in its child purely to get past it.
 *
 * THE CLASS: a report line on a path whose caller is not the TUI reads presentation
 * state the TUI owns. Closing the incident would mean guarding those two reads.
 * Closing the class means driving EVERY branch of the two entry points that print —
 * `updateViaBinaryAt`'s success line and each of `runUpdateCommand`'s four
 * report branches — in a child that has loaded no theme, so a newly added
 * unguarded read throws there and turns this suite red with no test change. Each
 * child also asserts `typeof theme === "undefined"` at the end, which is what keeps
 * it from passing for the wrong reason: without it, anything that quietly loaded a
 * theme during import would make every case green while the defect was intact.
 *
 * WHAT IT DOES NOT CATCH: a theme read on a path that prints nothing here — the
 * rollback picker, the plugin updater, the source-checkout update — and a read
 * inside `installRelease`, which is injected as a stub because production reaches
 * the network. It also cannot see a read that only a non-default theme would reach,
 * since an unloaded theme is a single state.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const UPDATE_CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli/update-cli.ts");
const THEME_BINDING = path.join(REPO_ROOT, "packages/coding-agent/src/modes/theme/theme-binding.ts");

/**
 * A stand-in release binary answering the three questions `verifyBinaryUsable`
 * asks of a freshly installed one: `--version` in the `veyyon/X.Y.Z` shape it
 * parses, `grep --help`, and a `grep` that really finds what it is pointed at.
 */
function standInBinary(version: string): string {
	return `#!/bin/sh
set -u
case "\${1:-}" in
	--version) echo "veyyon/${version}"; exit 0 ;;
	grep)
		[ "\${2:-}" = "--help" ] && { echo "usage: veyyon grep <pattern> <path>"; exit 0; }
		exec grep -rl -- "$2" "$3" ;;
	*) echo "unknown command: \${1:-}" >&2; exit 2 ;;
esac
`;
}

interface ChildRun {
	status: number | null;
	output: string;
}

/**
 * Runs `body` in a child that has loaded no theme and reports what it printed.
 *
 * A child process rather than an in-process call: `theme` is a module-level
 * binding, so any suite in the same process that has ever initialized a theme
 * would satisfy the read under test and this would prove nothing.
 *
 * The verdict is printed from an `exit` hook over the live ESM binding, so it is
 * reported on the branch that calls `process.exit(1)` as well, and it reports the
 * state at the END of the run: anything that loads a theme mid-flight says so
 * rather than making the case pass for a reason it does not claim.
 */
function runWithoutTheme(body: string): ChildRun {
	const script = `import { theme as loadedTheme } from ${JSON.stringify(THEME_BINDING)};
process.on("exit", () => {
	console.log(typeof loadedTheme === "undefined" ? "NO THEME" : "THEME WAS LOADED");
});
${body}
`;
	const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });
	return { status: run.status ?? null, output: `${run.stdout}${run.stderr}` };
}

/** A child that answers `getLatestRelease`'s HEAD probe with a redirect to `version`'s tag. */
function releaseStub(version: string): string {
	return `globalThis.fetch = async () =>
	new Response(null, { status: 302, headers: { location: "https://github.com/santhreal/veyyon/releases/tag/v${version}" } });
`;
}

describe("the update command says what it did with no theme loaded", () => {
	/**
	 * The reported defect, at the point where it costs the most: the swap is done,
	 * the new binary has answered `--version`, and the only thing left is to say so.
	 */
	it("reports a completed swap instead of dying while formatting the success line", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-no-theme-"));
		try {
			const target = path.join(dir, "veyyon");
			await fs.writeFile(target, standInBinary("1.0.0"), { mode: 0o755 });
			const payload = standInBinary("2.0.0");
			const run = runWithoutTheme(`
import * as crypto from "node:crypto";
import { updateViaBinaryAt } from ${JSON.stringify(UPDATE_CLI)};

const payload = ${JSON.stringify(payload)};
const digest = crypto.createHash("sha256").update(payload).digest("hex");
globalThis.fetch = async url => {
	const text = String(url).endsWith(".sha256") ? digest + "  veyyon\\n" : payload;
	return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
};

await updateViaBinaryAt(${JSON.stringify(target)}, "2.0.0", line => console.log("REPORT " + line));
`);
			expect(run.output, "the run must have had no theme, or it proves nothing").toContain("NO THEME");
			expect(run.status, run.output).toBe(0);
			expect(run.output).toContain("Updated to 2.0.0");
			// The mark the built-in themes resolve status.success to, so the line a
			// themed run prints and the line a bare one prints are the same line.
			expect(run.output).toContain("✓ Updated to 2.0.0");
			// The swap really happened; the message is not being printed over a no-op.
			expect(await fs.readFile(target, "utf8")).toBe(payload);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * `runUpdateCommand` prints on four mutually exclusive branches. Each is driven
	 * with the same empty theme, because guarding the one that was reported and
	 * leaving its siblings is exactly how this class stays open.
	 */
	const branches: { name: string; version: string; opts: string; expect: string }[] = [
		{
			name: "already up to date",
			version: "0.0.1",
			opts: "{ force: false, check: false }",
			expect: "✓ Already up to date",
		},
		{
			name: "up to date, --check with --force",
			version: "0.0.1",
			opts: "{ force: true, check: true }",
			expect: "Up to date at 0.0.1; --force would reinstall it",
		},
		{
			name: "up to date, --force reinstalls",
			version: "0.0.1",
			opts: "{ force: true, check: false }",
			expect: "Forcing reinstall of 0.0.1",
		},
		{
			name: "a newer release is available",
			version: "999.0.0",
			opts: "{ force: false, check: false }",
			expect: "New version available: 999.0.0",
		},
	];

	for (const branch of branches) {
		it(`prints the ${branch.name} branch`, () => {
			const run = runWithoutTheme(`
import { runUpdateCommand } from ${JSON.stringify(UPDATE_CLI)};

${releaseStub(branch.version)}
// installRelease reaches the network and owns its own reporting; the branch under
// test is what runUpdateCommand prints around it.
await runUpdateCommand(${branch.opts}, async () => {});
`);
			expect(run.output, "the run must have had no theme, or it proves nothing").toContain("NO THEME");
			expect(run.status, run.output).toBe(0);
			expect(run.output).toContain(branch.expect);
		});
	}

	/**
	 * The failure branch prints too, and it prints while deciding whether to offer
	 * `veyyon rollback` — which reads the install layout, not the theme. A throw
	 * here would replace a real update failure with a TypeError about presentation.
	 */
	it("prints the failed-install branch and exits 1", () => {
		const run = runWithoutTheme(`
import { runUpdateCommand } from ${JSON.stringify(UPDATE_CLI)};

${releaseStub("999.0.0")}
await runUpdateCommand({ force: false, check: false }, async () => {
	throw new Error("release download refused");
});
`);
		expect(run.output, "the run must have had no theme, or it proves nothing").toContain("NO THEME");
		expect(run.status, run.output).toBe(1);
		expect(run.output).toContain("Update failed: release download refused");
		expect(run.output).not.toContain("TypeError");
	});
});

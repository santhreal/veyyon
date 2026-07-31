/**
 * The update path's half of the completion refresh: how a stale completion is
 * surfaced when it cannot be rewritten.
 *
 * The mechanics live in src/cli/completion-refresh.ts and are covered by
 * completion-refresh.test.ts. What matters here is that a failure is reported
 * through the update result without writing directly to stderr. Automatic
 * updates run under a live TUI, so raw process output corrupts the frame; their
 * caller presents returned warnings inside the transcript instead.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { initTheme } from "../../src/modes/theme/theme";
import { enterTempHome, type TempHome } from "../helpers/temp-home";

let refreshCompletionsForInstalledBinary: typeof import("../../src/cli/update-cli").refreshCompletionsForInstalledBinary;
let updateViaSourceAt: typeof import("../../src/cli/update-cli").updateViaSourceAt;

beforeAll(async () => {
	// `theme` is a mutable global assigned by initTheme(); production initializes
	// it long before any update runs, and importing update-cli without it throws
	// on the first themed string.
	await initTheme();
	({ refreshCompletionsForInstalledBinary, updateViaSourceAt } = await import("../../src/cli/update-cli"));
});

describe("refreshCompletionsForInstalledBinary", () => {
	let home: string;
	let tempHome: TempHome;

	beforeEach(() => {
		tempHome = enterTempHome();
		home = tempHome.home;
	});

	afterEach(() => {
		tempHome.restore();
	});

	/** Seed a fish completion where install.sh would have written one. */
	function seedFishCompletion(body: string): string {
		const dir = path.join(home, ".config", "fish", "completions");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "veyyon.fish");
		fs.writeFileSync(file, body);
		return file;
	}

	/**
	 * A refresh failure must be actionable through the reporter while leaving raw
	 * stderr untouched. The automatic updater captures the structured failure for
	 * its transcript notification; the manual updater prints the reporter line.
	 */
	it("reports the exact stale completion without writing outside the TUI", async () => {
		const file = seedFishCompletion("# old\n");
		const reported: string[] = [];
		const result = await refreshCompletionsForInstalledBinary(
			"/nonexistent/veyyon",
			line => reported.push(line),
			async () => {
				throw new Error("exited 127: not found");
			},
		);
		expect(result.failed).toHaveLength(1);
		expect(reported.join("\n")).toContain(file);
		expect(reported.join("\n")).toContain("exited 127: not found");
		expect(reported.join("\n")).toContain("Re-run the installer");
	});

	it("reports only the successful refresh when every completion updates", async () => {
		// Warning on a healthy update trains the user to ignore the warning.
		const file = seedFishCompletion("# old\n");
		const reported: string[] = [];
		const result = await refreshCompletionsForInstalledBinary(
			"/nonexistent/veyyon",
			line => reported.push(line),
			async shell => `# fresh ${shell}\n`,
		);
		expect(result.failed).toEqual([]);
		expect(result.refreshed).toEqual([file]);
		expect(fs.readFileSync(file, "utf8")).toBe("# fresh fish\n");
		expect(reported.join("\n")).toContain("Refreshed 1 shell completion file(s)");
	});

	it("stays quiet when the user has no completions installed", async () => {
		// Most users never install completions; an update must not report work it
		// did not do, and must not fork the binary to generate a script for a file
		// that does not exist.
		const reported: string[] = [];
		let generatorCalls = 0;
		const result = await refreshCompletionsForInstalledBinary(
			"/nonexistent/veyyon",
			line => reported.push(line),
			async () => {
				generatorCalls += 1;
				return "# fresh\n";
			},
		);
		expect(result).toEqual({ refreshed: [], failed: [] });
		expect(generatorCalls).toBe(0);
		expect(reported).toEqual([]);
	});
});

/**
 * A source install goes stale exactly the same way a binary one does: the
 * checkout advances and the completion scripts on disk still describe the
 * version it left. Refreshing only the binary path would have fixed tab
 * completion for one of the two shipped install channels.
 */
describe("a source update refreshes completions too", () => {
	it("regenerates the installed completions after the checkout advances", async () => {
		const tempHome = enterTempHome();
		const home = tempHome.home;
		try {
			const completions = path.join(home, ".config", "fish", "completions");
			fs.mkdirSync(completions, { recursive: true });
			const stale = path.join(completions, "veyyon.fish");
			fs.writeFileSync(stale, "# from the previous version\n");
			const reported: string[] = [];

			const launcher = path.join(home, "src", "packages", "coding-agent", "scripts", "veyyon");
			const outcome = await updateViaSourceAt(
				launcher,
				"1.2.3",
				line => reported.push(line),
				async step => ({
					exitCode: 0,
					stdout: step.label === "Recording current revision" ? "1".repeat(40) : "",
					stderr: "",
				}),
				async () => "1.2.3",
				// The launcher does not exist here, which the real probe now refuses
				// outright; this test is about the refresh that runs after it.
				async () => undefined,
			);

			// The launcher does not exist in this sandbox, so generation fails.
			// The structured warning proves the source path ran the refresh and
			// gives automatic-update callers the data they need to render it.
			expect(outcome.warnings).toHaveLength(1);
			expect(outcome.warnings[0]).toContain(stale);
			expect(outcome.warnings[0]).toContain("still describes the previous version");
			expect(reported.join("\n")).toContain(stale);
		} finally {
			tempHome.restore();
		}
	});
});

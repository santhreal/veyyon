/**
 * The update path's half of the completion refresh: how a stale completion is
 * surfaced when it cannot be rewritten.
 *
 * The mechanics live in src/cli/completion-refresh.ts and are covered by
 * completion-refresh.test.ts. What matters here is that a failure is not
 * swallowed. The refresh runs at the very end of a successful update, including
 * the background auto-update whose reporter prints nothing at all, so routing
 * the failure through that reporter would mean a user's tab completion silently
 * stops matching their installed version with no message anywhere.
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
	let stderr: string;
	let restoreWrite: (() => void) | undefined;

	beforeEach(() => {
		tempHome = enterTempHome();
		home = tempHome.home;

		stderr = "";
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write;
		restoreWrite = () => {
			process.stderr.write = original;
		};
	});

	afterEach(() => {
		restoreWrite?.();
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

	it("names the exact stale file on stderr when the refresh fails", async () => {
		// The reporter is silent under auto-update, so this has to bypass it. A
		// warning the user cannot act on is no better than none: it names the file
		// and the way to fix it.
		const file = seedFishCompletion("# old\n");
		const result = await refreshCompletionsForInstalledBinary(
			"/nonexistent/veyyon",
			() => {},
			async () => {
				throw new Error("exited 127: not found");
			},
		);
		expect(result.failed).toHaveLength(1);
		expect(stderr).toContain(file);
		expect(stderr).toContain("exited 127: not found");
		expect(stderr).toContain("Re-run the installer");
	});

	it("says nothing on stderr when every completion refreshes", async () => {
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
		expect(stderr).toBe("");
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
		expect(stderr).toBe("");
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
		let stderr = "";
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			const completions = path.join(home, ".config", "fish", "completions");
			fs.mkdirSync(completions, { recursive: true });
			const stale = path.join(completions, "veyyon.fish");
			fs.writeFileSync(stale, "# from the previous version\n");

			const launcher = path.join(home, "src", "packages", "coding-agent", "scripts", "veyyon");
			await updateViaSourceAt(
				launcher,
				"1.2.3",
				() => {},
				async () => ({ exitCode: 0, stderr: "" }),
				async () => "1.2.3",
				// The launcher does not exist here, which the real probe now refuses
				// outright; this test is about the refresh that runs after it.
				async () => undefined,
			);

			// The launcher does not exist in this sandbox, so generation fails — and
			// that failure naming the stale file is the proof the refresh ran on this
			// path at all. A source update that skipped it would print nothing.
			expect(stderr).toContain(stale);
			expect(stderr).toContain("still describes the previous version");
		} finally {
			process.stderr.write = originalWrite;
			tempHome.restore();
		}
	});
});

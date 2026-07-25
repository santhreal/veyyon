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
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "../../src/modes/theme/theme";

let refreshCompletionsForInstalledBinary: typeof import("../../src/cli/update-cli").refreshCompletionsForInstalledBinary;

beforeAll(async () => {
	// `theme` is a mutable global assigned by initTheme(); production initializes
	// it long before any update runs, and importing update-cli without it throws
	// on the first themed string.
	await initTheme();
	({ refreshCompletionsForInstalledBinary } = await import("../../src/cli/update-cli"));
});

describe("refreshCompletionsForInstalledBinary", () => {
	let home: string;
	let originalHome: string | undefined;
	let originalDataHome: string | undefined;
	let originalConfigHome: string | undefined;
	let stderr: string;
	let restoreWrite: (() => void) | undefined;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-update-completions-"));
		originalHome = process.env.HOME;
		originalDataHome = process.env.XDG_DATA_HOME;
		originalConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.HOME = home;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_CONFIG_HOME;

		stderr = "";
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
			stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write;
		restoreWrite = () => {
			process.stderr.write = original;
		};
	});

	afterEach(() => {
		restoreWrite?.();
		fs.rmSync(home, { recursive: true, force: true });
		restoreEnv("HOME", originalHome);
		restoreEnv("XDG_DATA_HOME", originalDataHome);
		restoreEnv("XDG_CONFIG_HOME", originalConfigHome);
	});

	function restoreEnv(name: string, value: string | undefined): void {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

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

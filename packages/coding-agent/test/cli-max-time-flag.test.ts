import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runRootCommand } from "@veyyon/coding-agent/main";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { TempDir } from "@veyyon/utils";
import { APP_NAME } from "@veyyon/utils/dirs";
import { runCli } from "../src/cli";

describe("parseArgs — --max-time flag", () => {
	it("parses --max-time seconds as maxTime", () => {
		const result = parseArgs(["--max-time", "3", "--print", "hello"]);

		expect(result.maxTime).toBe(3);
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --max-time duration suffixes as seconds", () => {
		const cases = [
			{ value: "5s", expected: 5 },
			{ value: "10m", expected: 600 },
			{ value: "1h", expected: 3_600 },
		];

		for (const { value, expected } of cases) {
			const result = parseArgs(["--max-time", value, "--print", "hello"]);

			expect(result.maxTime).toBe(expected);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual(["hello"]);
		}
	});

	it("throws a visible parse error for invalid --max-time values", () => {
		const invalidValues = ["5d", "0", "-1", "Infinity", "NaN"];

		for (const value of invalidValues) {
			let thrown: unknown;

			try {
				parseArgs(["--max-time", value, "--print", "hello"]);
			} catch (error) {
				thrown = error;
			}

			if (!(thrown instanceof Error)) {
				throw new Error(`--max-time ${value} did not throw a visible parse error`);
			}
			expect(thrown.message).toContain("--max-time");
		}
	});

	it("reports invalid --max-time values as CLI usage errors", async () => {
		const previousExitCode = process.exitCode;
		let observedExitCode: string | number | null | undefined;
		const captured: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		// runCli runs the legacy-layout migration gate against ~/<configDirName>
		// before arg validation; on a machine whose real ~/.veyyon is in the
		// both-layouts conflict state that exits 1 and the usage error under
		// test never runs. bun's os.homedir() ignores runtime HOME mutation, so
		// isolation goes through the live-read VEYYON_CONFIG_DIR name instead.
		const configDirName = `.veyyon-max-time-test-${crypto.randomUUID()}`;
		const previousConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = configDirName;
		try {
			await runCli(["--max-time", "5d", "--print", "hello"]);
			observedExitCode = process.exitCode;
		} finally {
			if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
			else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
			await fs.rm(path.join(os.homedir(), configDirName), { recursive: true, force: true });
			vi.restoreAllMocks();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(observedExitCode).toBe(2);
		expect(stderr).toContain("Error: Invalid --max-time value");
		expect(stderr).toContain(`Run \`${APP_NAME} --help\` for available flags.`);
		expect(stderr).not.toContain("parseMaxTimeSeconds");
		expect(stderr).not.toContain("CliUsageError");
	});

	it("converts maxTime to an absolute session deadline", async () => {
		using tempDir = TempDir.createSync("@veyyon-max-time-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({});
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--max-time", "3", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		const beforeRun = Date.now();
		try {
			await runRootCommand(parsed, ["--max-time", "3", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}
		const afterRun = Date.now();

		expect(observedOptions?.deadline).toBeGreaterThanOrEqual(beforeRun + 3_000);
		expect(observedOptions?.deadline).toBeLessThanOrEqual(afterRun + 3_000);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand, suggestSettingPaths } from "@veyyon/coding-agent/cli/config-cli";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@veyyon/utils";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

let testAgentDir: TempDir | undefined;
const originalAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

beforeEach(() => {
	resetSettingsForTest();
	testAgentDir = TempDir.createSync("@veyyon-config-cli-");
	setAgentDir(testAgentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.resetInstance();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.VEYYON_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		try {
			await testAgentDir.remove();
		} catch {}
		testAgentDir = undefined;
	}
});

describe("config CLI schema coverage", () => {
	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("normalizes valid provider in-flight request limits from JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "providers.maxInFlightRequests",
			value: '{"openai":2.8,"anthropic":1}',
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "providers.maxInFlightRequests", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("providers.maxInFlightRequests");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ openai: 2, anthropic: 1 });
	});

	it("rejects invalid provider in-flight request limit entries", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({
				action: "set",
				key: "providers.maxInFlightRequests",
				value: '{"openai":"2","anthropic":0}',
				flags: { json: true },
			}),
		).rejects.toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Provider request limits must be positive numbers: openai, anthropic"),
		);
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const thresholdPayload = logSpy.mock.calls.at(-2)?.[0];
		const timeoutPayload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});

	it("accepts max as a persisted default thinking level", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "defaultThinkingLevel", value: "max", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "defaultThinkingLevel", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("defaultThinkingLevel");
		expect(parsed.type).toBe("enum");
		expect(parsed.value).toBe("max");
	});
	it("fully flushes JSON larger than a pipe buffer", async () => {
		if (!testAgentDir) throw new Error("Test agent directory was not initialized");
		const { env, cleanup } = hermeticSpawnEnv({ VEYYON_CODING_AGENT_DIR: testAgentDir.path() });
		let exitCode: number;
		let output: string;
		let error: string;
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "config", "list", "--json"], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
			const stdout = new Response(proc.stdout).text();
			const stderr = new Response(proc.stderr).text();
			[exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
		} finally {
			cleanup();
		}

		expect(exitCode).toBe(0);
		expect(error).toBe("");
		expect(Buffer.byteLength(output)).toBeGreaterThan(65_536);
		const parsed: unknown = JSON.parse(output);
		expect(parsed).toMatchObject({ modelRoles: { type: "record" } });
	});
});

describe("suggestSettingPaths", () => {
	// "Unknown setting" plus "run config list" is a dead end when the schema has
	// hundreds of paths. These lock the three ways a key usually goes wrong, so a
	// future ranking change cannot quietly stop helping.

	it("finds a path that differs only in capitalization", () => {
		// The most common miss: users type settings the way they read them in
		// prose, so the camelCase hump is dropped.
		expect(suggestSettingPaths("startup.autoupdate")).toEqual(["startup.autoUpdate"]);
		expect(suggestSettingPaths("THEME.DARK")).toEqual(["theme.dark"]);
	});

	it("finds a path from a remembered leaf name without its group", () => {
		expect(suggestSettingPaths("autoUpdate")).toContain("startup.autoUpdate");
	});

	it("finds a path from a single-character typo", () => {
		expect(suggestSettingPaths("theme.drk")).toEqual(["theme.dark"]);
		expect(suggestSettingPaths("compaction.stratgy")).toEqual(["compaction.strategy"]);
	});

	it("suggests nothing for a key that resembles no setting", () => {
		// Suggestions have to be worth reading. Offering an unrelated path for
		// unrelated input is noise, and noise is what makes users stop reading.
		expect(suggestSettingPaths("zzzzzzzz")).toEqual([]);
		expect(suggestSettingPaths("completely-made-up-key")).toEqual([]);
	});

	it("caps the list so the output stays scannable", () => {
		// A short prefix matches many paths; the point is a fix to paste, not a
		// second listing of the schema.
		expect(suggestSettingPaths("t").length).toBeLessThanOrEqual(3);
		expect(suggestSettingPaths("theme", 2).length).toBeLessThanOrEqual(2);
	});

	it("does not repeat a path that qualifies under more than one rule", () => {
		// An exact-but-for-case match is also a substring match and a near edit.
		const suggestions = suggestSettingPaths("startup.autoupdate");
		expect(new Set(suggestions).size).toBe(suggestions.length);
	});

	it("only suggests paths that actually exist", () => {
		// A suggestion the user cannot then set would be worse than none.
		for (const key of ["startup.autoupdate", "theme.drk", "autoUpdate"]) {
			for (const suggestion of suggestSettingPaths(key)) {
				// Keys hold dots, so check membership rather than toHaveProperty, which
				// reads a dot as a nested path.
				expect(Object.keys(SETTINGS_SCHEMA)).toContain(suggestion);
			}
		}
	});
});

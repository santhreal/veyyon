import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@veyyon/pi-ai/types";
import { buildModel } from "@veyyon/pi-catalog/build";
import { Settings } from "@veyyon/pi-coding-agent/config/settings";
import {
	filterToolsByHarnessProfile,
	isRepairEnabledForModel,
	resetHarnessProfileFileCache,
	resolveHarnessProfileForModel,
} from "@veyyon/pi-coding-agent/harness/model-profile";
import { removeSyncWithRetries, Snowflake, setAgentDir } from "@veyyon/pi-utils";

const model: Model = buildModel({
	id: "gpt-test",
	name: "gpt-test",
	provider: "openai",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
}) as Model;

describe("harness model profiles (A3 MVP)", () => {
	let tempDir: string;

	afterEach(() => {
		resetHarnessProfileFileCache();
		if (tempDir) removeSyncWithRetries(tempDir);
	});

	it("resolves exact and wildcard profile keys from settings", () => {
		const settings = Settings.isolated({
			"harness.profiles": {
				"openai/gpt-test": { repair: false, tools: ["read", "edit"] },
				"anthropic/*": { repair: true },
			},
		});
		expect(resolveHarnessProfileForModel(settings, model)).toEqual({
			repair: false,
			tools: ["read", "edit"],
		});
	});

	it("loads harness-profiles.yml from agent dir", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-profile-${Snowflake.next()}-`));
		setAgentDir(tempDir);
		resetHarnessProfileFileCache();
		fs.writeFileSync(
			path.join(tempDir, "harness-profiles.yml"),
			"profiles:\n  openai/gpt-test:\n    repair: false\n",
		);
		const settings = Settings.isolated({ "harness.profiles": {} });
		expect(isRepairEnabledForModel(settings, model)).toBe(false);
	});

	it("filters initial tool names by allowlist", () => {
		const settings = Settings.isolated({
			"harness.profiles": { "openai/gpt-test": { tools: ["read", "grep"] } },
		});
		expect(filterToolsByHarnessProfile(["read", "edit", "bash"], settings, model)).toEqual(["read"]);
	});
});

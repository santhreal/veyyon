import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	filterToolsByHarnessProfile,
	isRepairEnabledForModel,
	resetHarnessProfileFileCache,
	resolveHarnessProfileForModel,
	resolvePromptSectionOrderForModel,
} from "@veyyon/coding-agent/harness/model-profile";
import { logger, removeSyncWithRetries, Snowflake, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

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

// Two of the tests below point the agent dir at a temp tree and nothing put it back,
// so the whole process kept resolving `harness-profiles.yml` (and everything else under
// the agent dir) inside a directory this file had already deleted.
const dirOverrides = captureDirOverrides();

describe("harness model profiles (A3 MVP)", () => {
	let tempDir: string;

	afterEach(() => {
		resetHarnessProfileFileCache();
		restoreDirOverrides(dirOverrides);
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

	it("resolves promptSectionOrder, deduplicated", () => {
		const settings = Settings.isolated({
			"harness.profiles": {
				"openai/gpt-test": { promptSectionOrder: ["tool-policy", "role", "tool-policy"] },
			},
		});
		expect(resolvePromptSectionOrderForModel(settings, model)).toEqual(["tool-policy", "role"]);
	});

	it("rejects a promptSectionOrder list containing an unknown section name", () => {
		const settings = Settings.isolated({
			"harness.profiles": {
				"openai/gpt-test": { repair: false, promptSectionOrder: ["tool-policy", "bogus-section"] },
			},
		});
		// The whole list drops (a typo'd entry must not silently apply a different
		// order), while the rest of the profile survives.
		expect(resolvePromptSectionOrderForModel(settings, model)).toBeUndefined();
		expect(isRepairEnabledForModel(settings, model)).toBe(false);
	});

	/**
	 * The half a typo'd NAME already covered, for a value that is not a name at all.
	 *
	 * `promptSectionOrder: [role, 42, runtime]` used to skip the `42` and apply
	 * `[role, runtime]` — an order the operator did not write — while the very next
	 * branch rejected the whole list for a misspelled name, with a comment saying why.
	 * Two answers to one fact, and the silent one is reached by the input a hand-edited
	 * YAML file is most likely to contain.
	 */
	it("rejects a promptSectionOrder list containing a non-string entry", () => {
		const settings = Settings.isolated({
			"harness.profiles": {
				"openai/gpt-test": { repair: false, promptSectionOrder: ["role", 42, "runtime"] },
			},
		});

		expect(resolvePromptSectionOrderForModel(settings, model)).toBeUndefined();
		// The rest of the profile survives, exactly as it does for a misspelled name.
		expect(isRepairEnabledForModel(settings, model)).toBe(false);
	});

	/**
	 * The tool allowlist gets the same rule, and the stakes are higher because this
	 * list DENIES tools. Filtering the bad entry out left a shorter allowlist than was
	 * written, so the model quietly lost a tool and the later "why can it not do that"
	 * has nothing pointing at a YAML typo.
	 */
	it("rejects a tools allowlist containing a non-name entry", () => {
		const settings = Settings.isolated({
			"harness.profiles": { "openai/gpt-test": { tools: ["read", 42, "bash"] } },
		});

		// No allowlist at all, so every tool stays available — the safe direction. A
		// two-entry allowlist built from a three-entry list would have hidden `bash`.
		expect(filterToolsByHarnessProfile(["read", "edit", "bash"], settings, model)).toEqual(["read", "edit", "bash"]);
	});

	/** An empty string is not a tool name either, and reaches the same refusal. */
	it("rejects a tools allowlist containing an empty name", () => {
		const settings = Settings.isolated({
			"harness.profiles": { "openai/gpt-test": { tools: ["read", ""] } },
		});

		expect(filterToolsByHarnessProfile(["read", "edit"], settings, model)).toEqual(["read", "edit"]);
	});

	/**
	 * A `harness-profiles.yml` that cannot be parsed is reported, not read as absent.
	 *
	 * The loader had an `ENOENT` branch and a fallthrough that both returned `{}`, so
	 * it looked like the two cases were distinguished while a YAML syntax error dropped
	 * every profile the operator wrote and started the agent on the defaults, silently.
	 */
	it("reports a harness-profiles.yml it cannot parse", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-profile-${Snowflake.next()}-`));
		setAgentDir(tempDir);
		resetHarnessProfileFileCache();
		fs.writeFileSync(path.join(tempDir, "harness-profiles.yml"), "profiles:\n  openai/gpt-test:\n   - [unclosed\n");

		const warnings: string[] = [];
		const spy = vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			const settings = Settings.isolated({ "harness.profiles": {} });
			expect(resolvePromptSectionOrderForModel(settings, model)).toBeUndefined();
		} finally {
			spy.mockRestore();
		}

		expect(warnings.some(message => message.includes("harness-profiles.yml could not be read"))).toBe(true);
	});

	/** A missing file is the ordinary case and stays quiet. */
	it("says nothing when there is no harness-profiles.yml", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-profile-${Snowflake.next()}-`));
		setAgentDir(tempDir);
		resetHarnessProfileFileCache();

		const warnings: string[] = [];
		const spy = vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			const settings = Settings.isolated({ "harness.profiles": {} });
			expect(resolveHarnessProfileForModel(settings, model)).toBeUndefined();
		} finally {
			spy.mockRestore();
		}

		expect(warnings).toEqual([]);
	});

	it("loads promptSectionOrder from harness-profiles.yml", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-profile-${Snowflake.next()}-`));
		setAgentDir(tempDir);
		resetHarnessProfileFileCache();
		fs.writeFileSync(
			path.join(tempDir, "harness-profiles.yml"),
			"profiles:\n  openai/gpt-test:\n    promptSectionOrder: [delivery-contract, role]\n",
		);
		const settings = Settings.isolated({ "harness.profiles": {} });
		expect(resolvePromptSectionOrderForModel(settings, model)).toEqual(["delivery-contract", "role"]);
	});
});

/**
 * `composer.predictions.enabled` and `.source` became one `composer.predictions.mode`, whose default
 * (`chatgpt-pro`) runs whenever a ChatGPT Pro Codex login is present. A config that stored
 * `enabled: false` stored an opt-out; dropping the old key would let that default switch
 * predictions back on. Each case loads a config file through the real loader and reads the mode
 * back, and the rewrite case checks that the retired keys leave the file.
 *
 * Not covered: an opt-out held anywhere other than a settings source the loader migrates.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeAgentDir = useTrackedTempDirs("veyyon-prediction-mode-migration-");

describe("the composer prediction mode rename", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeAgentDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "prediction-mode-migration"));
			agentDir = "";
		}
	});

	function writeConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	async function modeAfterLoading(config: Record<string, unknown>): Promise<unknown> {
		writeConfig(config);
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		return settings.get("composer.predictions.mode");
	}

	test.each([
		["enabled: false", { enabled: false }, "off"],
		["enabled: false with source: model", { enabled: false, source: "model" }, "off"],
		["enabled: false with source: codex", { enabled: false, source: "codex" }, "off"],
		["enabled: true with source: model", { enabled: true, source: "model" }, "custom"],
		["enabled: true with source: codex", { enabled: true, source: "codex" }, "chatgpt-pro"],
		["enabled: true with no source", { enabled: true }, "chatgpt-pro"],
	])("maps %s, written nested", async (_case, predictions, expected) => {
		expect(await modeAfterLoading({ composer: { predictions } })).toBe(expected);
	});

	test("maps a flat enabled: false to off", async () => {
		expect(await modeAfterLoading({ "composer.predictions.enabled": false })).toBe("off");
	});

	test("keeps a mode already stored over the retired keys", async () => {
		expect(await modeAfterLoading({ composer: { predictions: { mode: "custom", enabled: false } } })).toBe("custom");
	});

	test("leaves the default in place when no retired key was stored", async () => {
		expect(await modeAfterLoading({ composer: { predictions: { model: "openai/gpt-5.5" } } })).toBe("chatgpt-pro");
	});

	test("writes the opt-out back as mode: off and drops the retired keys", async () => {
		writeConfig({ composer: { predictions: { enabled: false, source: "codex" } } });
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		await settings.set("ask.notify" as never, "on" as never);
		await settings.flush?.();

		const written = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as {
			composer?: { predictions?: Record<string, unknown> };
		};
		expect(written.composer?.predictions).toEqual({ mode: "off" });

		const reloaded = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		expect(reloaded.get("composer.predictions.mode")).toBe("off");
	});
});

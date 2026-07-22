import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Cross-tool write → bash cat → read chain: all three see the same body.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function bashSession(cwd: string, settings: Settings) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "chain",
		allocateOutputArtifact: async kind => ({
			id: `${kind}-1`,
			path: path.join(cwd, `${kind}-1.txt`),
		}),
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return settings.get(key as never);
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

describe("write→bash cat→read chain adversarial", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir: string;

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbr-chain-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("all three surfaces report the same payload body", async () => {
		const settings = Settings.isolated({
			"lsp.formatOnWrite": false,
			"lsp.diagnosticsOnWrite": false,
			"read.summarize.enabled": false,
		});
		const toolSession = makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "s.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
			settings,
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
		const body = "shared-payload-xyz\n";
		const file = path.join(tmpDir, "shared.ts");
		await new WriteTool(toolSession).execute("w", { path: file, content: body });
		expect(await Bun.file(file).text()).toBe(body);

		const bash = new BashTool(bashSession(tmpDir, settings) as never);
		const bashText = textOf(await bash.execute("b", { command: "cat shared.ts", timeout: 15 }));
		expect(bashText).toContain("shared-payload-xyz");

		const readText = textOf(await new ReadTool(toolSession).execute("r", { path: file }));
		expect(readText).toContain("shared-payload-xyz");
	});
});

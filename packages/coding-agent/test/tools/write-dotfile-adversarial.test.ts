import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("write/read dotfiles adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dotfile-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "s.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("writes and reads .env.local with exact content", async () => {
		const s = session();
		const file = path.join(tmpDir, ".env.local");
		const content = "SECRET=1\nOTHER=2\n";
		await new WriteTool(s).execute("w", { path: file, content });
		expect(await Bun.file(file).text()).toBe(content);
		expect(textOf(await new ReadTool(s).execute("r", { path: file }))).toContain("SECRET=1");
	});

	it("writes nested .config/app.json", async () => {
		const s = session();
		const file = path.join(tmpDir, ".config", "app.json");
		const content = '{"ok":true}\n';
		await new WriteTool(s).execute("w", { path: file, content });
		expect(await Bun.file(file).text()).toBe(content);
	});
});

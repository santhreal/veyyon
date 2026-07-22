import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GrepTool } from "@veyyon/coding-agent/tools/grep";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("write→grep→read chain adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wgr-chain-"));
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
				"grep.enabled": true,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("write unique token, grep finds it, read returns the same body", async () => {
		const s = session();
		const file = path.join(tmpDir, "hit.ts");
		const token = "UNIQUE_TOKEN_ZX9Q";
		const body = `const x = '${token}';\n`;
		await new WriteTool(s).execute("w", { path: file, content: body });
		const grepText = textOf(
			await new GrepTool(s as never).execute("g", { pattern: token, path: file }),
		);
		expect(grepText).toContain(token);
		const readText = textOf(await new ReadTool(s).execute("r", { path: file }));
		expect(readText).toContain(token);
		expect(await Bun.file(file).text()).toBe(body);
	});
});

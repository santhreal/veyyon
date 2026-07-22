import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GlobTool } from "@veyyon/coding-agent/tools/glob";
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

/**
 * write files → glob finds them → read each found file returns its body.
 */

describe("write→glob→read chain adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wgr-glob-"));
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
				"glob.enabled": true,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("glob discovers written files and read returns each body", async () => {
		const s = session();
		const write = new WriteTool(s);
		const bodies: Record<string, string> = {
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 2;\n",
		};
		for (const [rel, body] of Object.entries(bodies)) {
			await write.execute(`w-${rel}`, { path: path.join(tmpDir, rel), content: body });
		}
		const globText = textOf(await new GlobTool(s as never).execute("g", { path: "src/**/*.ts" }));
		expect(globText).toContain("a.ts");
		expect(globText).toContain("b.ts");
		const read = new ReadTool(s);
		for (const [rel, body] of Object.entries(bodies)) {
			const out = textOf(await read.execute(`r-${rel}`, { path: path.join(tmpDir, rel) }));
			expect(out).toContain(body.trim());
		}
	});
});

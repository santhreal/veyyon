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

/**
 * Relative path write/read, multi-overwrite sequences, and byte-count reports.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("relative write/read overwrite adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rel-wr-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "r", path: path.join(tmpDir, "r.log") }),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("write via relative path then read via absolute sees the same body", async () => {
		const s = session();
		const content = "rel-body-42\n";
		await new WriteTool(s).execute("w", { path: "sub/rel.ts", content });
		const abs = path.join(tmpDir, "sub", "rel.ts");
		expect(await Bun.file(abs).text()).toBe(content);
		expect(textOf(await new ReadTool(s).execute("r", { path: abs }))).toContain("rel-body-42");
	});

	it("ten overwrites leave only the final body on disk", async () => {
		const s = session();
		const file = path.join(tmpDir, "many.ts");
		const write = new WriteTool(s);
		for (let i = 0; i < 10; i++) {
			await write.execute(`w${i}`, { path: file, content: `v${i}\n` });
		}
		expect(await Bun.file(file).text()).toBe("v9\n");
		expect(textOf(await new ReadTool(s).execute("r", { path: file }))).toContain("v9");
		expect(textOf(await new ReadTool(s).execute("r2", { path: file })).includes("v0")).toBe(false);
	});

	it("write reports exact byte count for multi-byte unicode", async () => {
		const s = session();
		const content = "絵文字🙂\n";
		const result = await new WriteTool(s).execute("w", { path: "u.ts", content });
		expect(textOf(result)).toContain(`Successfully wrote ${content.length} bytes`);
		expect(await Bun.file(path.join(tmpDir, "u.ts")).text()).toBe(content);
	});

	it("read of a just-written empty file has no invented body lines", async () => {
		const s = session();
		const file = path.join(tmpDir, "empty.ts");
		await new WriteTool(s).execute("w", { path: file, content: "" });
		const out = textOf(await new ReadTool(s).execute("r", { path: file }));
		const body = out
			.split("\n")
			.filter(l => !l.startsWith("["))
			.join("")
			.trim();
		expect(body === "" || /empty|0 line/i.test(out)).toBe(true);
	});
});

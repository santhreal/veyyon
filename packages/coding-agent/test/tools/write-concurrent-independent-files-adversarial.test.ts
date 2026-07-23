import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Concurrent writes to independent files leave exact independent content.
 */

describe("WriteTool concurrent independent files", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-conc-"));
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
			allocateOutputArtifact: async () => ({ id: "c", path: path.join(tmpDir, "c.log") }),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("Promise.all writes to 20 distinct files leave exact per-file content", async () => {
		const s = session();
		const tool = new WriteTool(s);
		const jobs = Array.from({ length: 20 }, (_, i) => {
			const p = path.join(tmpDir, `f${i}.ts`);
			const content = `export const n = ${i};\n`;
			return tool.execute(`w${i}`, { path: p, content }).then(async () => {
				expect(await Bun.file(p).text()).toBe(content);
			});
		});
		await Promise.all(jobs);
		for (let i = 0; i < 20; i++) {
			expect(await Bun.file(path.join(tmpDir, `f${i}.ts`)).text()).toBe(`export const n = ${i};\n`);
		}
	});

	it("concurrent overwrite of the same file ends with one complete payload", async () => {
		const s = session();
		const tool = new WriteTool(s);
		const file = path.join(tmpDir, "race.ts");
		const a = `${"A".repeat(2000)}\n`;
		const b = `${"B".repeat(2000)}\n`;
		await Promise.all([
			tool.execute("wa", { path: file, content: a }),
			tool.execute("wb", { path: file, content: b }),
		]);
		const out = await Bun.file(file).text();
		expect(out === a || out === b).toBe(true);
		expect(out.includes("A") && out.includes("B")).toBe(false);
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
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

describe("ReadTool range multi-file adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-range-"));
		const lines = Array.from({ length: 30 }, (_, i) => `ROW${i + 1}`);
		await Bun.write(path.join(tmpDir, "big.ts"), `${lines.join("\n")}\n`);
		await Bun.write(path.join(tmpDir, "small.ts"), "only\n");
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
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
	}

	it("open-ended :25- includes line 25 and later", async () => {
		const tool = new ReadTool(session());
		const file = path.join(tmpDir, "big.ts");
		const out = textOf(await tool.execute("r1", { path: `${file}:25-` }));
		expect(out).toContain("ROW25");
		expect(out).toContain("ROW30");
		// Early lines should be absent (allowing small context padding).
		expect(out.includes("ROW1") && !out.includes("ROW25")).toBe(false);
	});

	it("single-line :10-10 returns ROW10", async () => {
		const tool = new ReadTool(session());
		const file = path.join(tmpDir, "big.ts");
		const out = textOf(await tool.execute("r2", { path: `${file}:10-10` }));
		expect(out).toContain("ROW10");
	});

	it("reading two different files returns independent bodies", async () => {
		const tool = new ReadTool(session());
		const a = textOf(await tool.execute("ra", { path: path.join(tmpDir, "big.ts") }));
		const b = textOf(await tool.execute("rb", { path: path.join(tmpDir, "small.ts") }));
		expect(a).toContain("ROW1");
		expect(b).toContain("only");
		expect(b.includes("ROW15")).toBe(false);
	});

	it("out-of-range high start does not invent rows beyond file length", async () => {
		const tool = new ReadTool(session());
		const file = path.join(tmpDir, "small.ts");
		let out = "";
		try {
			out = textOf(await tool.execute("r3", { path: `${file}:50-60` }));
		} catch (e) {
			out = String(e);
		}
		expect(out.includes("ROW50")).toBe(false);
		expect(out.includes("invented")).toBe(false);
	});
});

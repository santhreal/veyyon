import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
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
 * Cross-tool write→read chains: hashline header stability, multi-file
 * independence, and plan-mode mid-chain gate. Exact disk + body asserts.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("write→read chain adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-chain-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session(opts: { planEnabled?: boolean } = {}) {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({
				id: "c1",
				path: path.join(tmpDir, "c1.log"),
			}),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
			}),
			enableLsp: false,
			getPlanModeState: () =>
				opts.planEnabled ? { enabled: true, planFilePath: "local://plan.md" } : { enabled: false },
		});
	}

	it("write then read returns the written body under a hashline header", async () => {
		const s = session();
		const filePath = path.join(tmpDir, "chain.ts");
		const content = "export const chain = 1;\n";
		await new WriteTool(s).execute("w", { path: filePath, content });
		const out = textOf(await new ReadTool(s).execute("r", { path: filePath }));
		expect(out).toMatch(/\[[^\]]+#[0-9A-Fa-f]{4}\]/);
		expect(out).toContain("export const chain = 1;");
	});

	it("write→read→overwrite→read shows only the second body", async () => {
		const s = session();
		const filePath = path.join(tmpDir, "mutate.ts");
		const write = new WriteTool(s);
		const read = new ReadTool(s);
		await write.execute("w1", { path: filePath, content: "v1\n" });
		expect(textOf(await read.execute("r1", { path: filePath }))).toContain("v1");
		await write.execute("w2", { path: filePath, content: "v2-final\n" });
		const out = textOf(await read.execute("r2", { path: filePath }));
		expect(out).toContain("v2-final");
		expect(out.includes("v1")).toBe(false);
		expect(await Bun.file(filePath).text()).toBe("v2-final\n");
	});

	it("two files written then read independently keep distinct bodies", async () => {
		const s = session();
		const a = path.join(tmpDir, "a.ts");
		const b = path.join(tmpDir, "b.ts");
		const write = new WriteTool(s);
		const read = new ReadTool(s);
		await write.execute("wa", { path: a, content: "AAA\n" });
		await write.execute("wb", { path: b, content: "BBB\n" });
		expect(textOf(await read.execute("ra", { path: a }))).toContain("AAA");
		expect(textOf(await read.execute("rb", { path: b }))).toContain("BBB");
		expect(textOf(await read.execute("ra2", { path: a })).includes("BBB")).toBe(false);
	});

	it("hashline tag from read after write is stable until another write", async () => {
		const s = session();
		const filePath = path.join(tmpDir, "tag.ts");
		const write = new WriteTool(s);
		const read = new ReadTool(s);
		await write.execute("w1", { path: filePath, content: "stable\n" });
		const h1 = textOf(await read.execute("r1", { path: filePath })).split("\n")[0]!;
		const h2 = textOf(await read.execute("r2", { path: filePath })).split("\n")[0]!;
		expect(h1).toBe(h2);
		await write.execute("w2", { path: filePath, content: "changed\n" });
		const h3 = textOf(await read.execute("r3", { path: filePath })).split("\n")[0]!;
		expect(h3).not.toBe(h1);
	});

	it("plan mode blocks write after a successful write→read of the same path", async () => {
		const sOpen = session({ planEnabled: false });
		const filePath = path.join(tmpDir, "gated.ts");
		await new WriteTool(sOpen).execute("w1", { path: filePath, content: "ok\n" });
		expect(textOf(await new ReadTool(sOpen).execute("r1", { path: filePath }))).toContain("ok");

		const sPlan = session({ planEnabled: true });
		await expect(
			new WriteTool(sPlan).execute("w2", { path: filePath, content: "nope\n" }),
		).rejects.toThrow(/working tree is read-only/i);
		expect(await Bun.file(filePath).text()).toBe("ok\n");
		// Read still works under plan mode (read is not a tree mutation).
		expect(textOf(await new ReadTool(sPlan).execute("r2", { path: filePath }))).toContain("ok");
	});

	it("unicode write→read preserves codepoints", async () => {
		const s = session();
		const filePath = path.join(tmpDir, "jp.ts");
		const content = "const 絵 = '🙂';\n";
		await new WriteTool(s).execute("w", { path: filePath, content });
		const out = textOf(await new ReadTool(s).execute("r", { path: filePath }));
		expect(out).toContain("絵");
		expect(out).toContain("🙂");
		expect(await Bun.file(filePath).text()).toBe(content);
	});
});

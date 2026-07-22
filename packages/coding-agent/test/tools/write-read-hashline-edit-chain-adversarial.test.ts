import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executeHashlineSingle } from "@veyyon/coding-agent/edit";
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
 * Full write → read → hashline SWAP → read chain with exact disk bytes.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("write→read→edit→read chain adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wre-chain-"));
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
			allocateOutputArtifact: async () => ({ id: "e", path: path.join(tmpDir, "e.log") }),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	function editOpts(sess: ReturnType<typeof session>, input: string) {
		return {
			session: sess,
			input,
			writethrough: async (targetPath: string, content: string) => {
				await Bun.write(targetPath, content);
				return undefined;
			},
			beginDeferredDiagnosticsForPath: () => ({
				onDeferredDiagnostics: () => {},
				signal: new AbortController().signal,
				finalize: () => {},
			}),
		};
	}

	it("write three lines, SWAP middle, disk is exact", async () => {
		const s = session();
		const file = path.join(tmpDir, "m.ts");
		await new WriteTool(s).execute("w", { path: file, content: "L1\nL2\nL3\n" });
		const header = textOf(await new ReadTool(s).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(editOpts(s, `${header}\nSWAP 2.=2:\n+MID\n`));
		expect(await Bun.file(file).text()).toBe("L1\nMID\nL3\n");
		const after = textOf(await new ReadTool(s).execute("r2", { path: file }));
		expect(after).toContain("MID");
		expect(after).toContain("L1");
		expect(after).toContain("L3");
	});

	it("write, INS.TAIL via edit path after read header", async () => {
		const s = session();
		const file = path.join(tmpDir, "t.ts");
		await new WriteTool(s).execute("w", { path: file, content: "only\n" });
		const header = textOf(await new ReadTool(s).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(editOpts(s, `${header}\nINS.TAIL:\n+tail\n`));
		expect(await Bun.file(file).text()).toBe("only\ntail\n");
	});

	it("write, DEL last line, disk drops it", async () => {
		const s = session();
		const file = path.join(tmpDir, "d.ts");
		await new WriteTool(s).execute("w", { path: file, content: "a\nb\nc\n" });
		const header = textOf(await new ReadTool(s).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(editOpts(s, `${header}\nDEL 3.=3\n`));
		expect(await Bun.file(file).text()).toBe("a\nb\n");
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executeHashlineSingle } from "@veyyon/coding-agent/edit";
import { GrepTool } from "@veyyon/coding-agent/tools/grep";
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

/**
 * write → grep (find token) → read header → SWAP token → grep confirms change.
 */

describe("write→grep→edit→grep chain adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wge-chain-"));
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

	it("token is replaced and old token disappears from grep", async () => {
		const s = session();
		const file = path.join(tmpDir, "chain.ts");
		const oldTok = "OLD_TOKEN_AAA";
		const newTok = "NEW_TOKEN_BBB";
		await new WriteTool(s).execute("w", {
			path: file,
			content: `const x = '${oldTok}';\n`,
		});
		expect(textOf(await new GrepTool(s as never).execute("g1", { pattern: oldTok, path: file }))).toContain(oldTok);

		const header = textOf(await new ReadTool(s).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(editOpts(s, `${header}\nSWAP 1.=1:\n+const x = '${newTok}';\n`));
		expect(await Bun.file(file).text()).toBe(`const x = '${newTok}';\n`);
		expect(textOf(await new GrepTool(s as never).execute("g2", { pattern: newTok, path: file }))).toContain(newTok);
		const oldGrep = textOf(await new GrepTool(s as never).execute("g3", { pattern: oldTok, path: file }));
		expect(oldGrep.includes(oldTok)).toBe(false);
	});
});

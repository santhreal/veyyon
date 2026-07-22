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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

/**
 * Multi-line SWAP: replace a 2-line range with 3 lines.
 */

describe("write→read→multi-line SWAP adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ml-swap-"));
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

	it("SWAP 2.=3 replaces two lines with three", async () => {
		const s = session();
		const file = path.join(tmpDir, "m.ts");
		await new WriteTool(s).execute("w", { path: file, content: "L1\nL2\nL3\nL4\n" });
		const header = textOf(await new ReadTool(s).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(
			editOpts(s, `${header}\nSWAP 2.=3:\n+A\n+B\n+C\n`),
		);
		expect(await Bun.file(file).text()).toBe("L1\nA\nB\nC\nL4\n");
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executeHashlineSingle } from "@veyyon/coding-agent/edit";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("edit INS.HEAD/TAIL through executeHashlineSingle", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-ins-"));
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
			allocateOutputArtifact: async () => ({ id: "e", path: path.join(tmpDir, "e.log") }),
			settings: Settings.isolated({
				"read.summarize.enabled": false,
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
			}),
			enableLsp: false,
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

	it("INS.HEAD prepends a line on disk", async () => {
		const file = path.join(tmpDir, "h.ts");
		await Bun.write(file, "body\n");
		const sess = session();
		const header = textOf(await new ReadTool(sess).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(editOpts(sess, `${header}\nINS.HEAD:\n+HEAD\n`));
		expect(await Bun.file(file).text()).toBe("HEAD\nbody\n");
	});

	it("INS.TAIL appends a line on disk", async () => {
		const file = path.join(tmpDir, "t.ts");
		await Bun.write(file, "body\n");
		const sess = session();
		const header = textOf(await new ReadTool(sess).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(editOpts(sess, `${header}\nINS.TAIL:\n+TAIL\n`));
		expect(await Bun.file(file).text()).toBe("body\nTAIL\n");
	});
});

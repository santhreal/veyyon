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
 * Plan-mode local:// write then read chain: sandbox is writable, tree is not.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("plan-mode local:// write→read chain", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-local-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		const artifacts = path.join(tmpDir, "artifacts");
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifacts,
			getSessionId: () => "plan-local",
			allocateOutputArtifact: async () => ({
				id: "p1",
				path: path.join(tmpDir, "p1.log"),
			}),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://my-plan.md" }),
		});
	}

	it("writes a plan to local:// and can read it back under plan mode", async () => {
		const s = session();
		const write = new WriteTool(s);
		const read = new ReadTool(s);
		const body = "# Plan\n\n- step one\n";
		await write.execute("w1", { path: "local://my-plan.md", content: body });
		const onDisk = path.join(tmpDir, "artifacts", "local", "my-plan.md");
		// Artifact layout may nest under session id; find the file.
		let found = "";
		if (await Bun.file(onDisk).exists()) {
			found = await Bun.file(onDisk).text();
		} else {
			// Search under artifacts for my-plan.md
			const { readdir } = await import("node:fs/promises");
			async function walk(dir: string): Promise<string | null> {
				let entries: string[];
				try {
					entries = await readdir(dir);
				} catch {
					return null;
				}
				for (const e of entries) {
					const p = path.join(dir, e);
					if (e === "my-plan.md") return p;
					const nested = await walk(p);
					if (nested) return nested;
				}
				return null;
			}
			const hit = await walk(path.join(tmpDir, "artifacts"));
			if (hit) found = await Bun.file(hit).text();
		}
		expect(found === body || textOf(await read.execute("r1", { path: "local://my-plan.md" })).includes("step one")).toBe(
			true,
		);
	});

	it("still blocks tree writes while allowing a second local:// write", async () => {
		const s = session();
		const write = new WriteTool(s);
		await write.execute("w1", { path: "local://notes.md", content: "n1\n" });
		await expect(
			write.execute("w2", { path: path.join(tmpDir, "tree.ts"), content: "nope\n" }),
		).rejects.toThrow(/working tree is read-only/i);
		await write.execute("w3", { path: "local://notes.md", content: "n2\n" });
		expect(await Bun.file(path.join(tmpDir, "tree.ts")).exists()).toBe(false);
	});
});

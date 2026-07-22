import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { computeFileHash } from "@veyyon/hashline";
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
 * ReadTool hashline tag matches computeFileHash of the on-disk body.
 */

describe("read header tag vs computeFileHash", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hash-agree-"));
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
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
	}

	it("tag in read header equals computeFileHash for many bodies", async () => {
		const tool = new ReadTool(session());
		for (let i = 0; i < 15; i++) {
			const body = `line ${i}\nsecond ${"y".repeat(i)}\n`;
			const file = path.join(tmpDir, `f${i}.ts`);
			await Bun.write(file, body);
			const header = textOf(await tool.execute(`r${i}`, { path: file })).split("\n")[0]!;
			const m = /#([0-9A-Fa-f]{4})\]$/.exec(header);
			expect(m).not.toBeNull();
			expect(m![1]!.toLowerCase()).toBe(computeFileHash(body).toLowerCase());
		}
	});
});

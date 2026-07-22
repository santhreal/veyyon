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

/**
 * Hashline header stability: same content → same tag; changed content → new tag.
 */

describe("read hashline stability property", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hl-stab-"));
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

	it("for 20 distinct bodies, two reads agree and a mutation changes the tag", async () => {
		const tool = new ReadTool(session());
		for (let i = 0; i < 20; i++) {
			const file = path.join(tmpDir, `f${i}.ts`);
			const body = `export const n = ${i};\n// pad ${"x".repeat(i)}\n`;
			await Bun.write(file, body);
			const h1 = textOf(await tool.execute(`r1-${i}`, { path: file })).split("\n")[0]!;
			const h2 = textOf(await tool.execute(`r2-${i}`, { path: file })).split("\n")[0]!;
			expect(h1).toMatch(/^\[.+#[0-9A-Fa-f]{4}\]$/);
			expect(h1).toBe(h2);
			await Bun.write(file, body + "// changed\n");
			const h3 = textOf(await tool.execute(`r3-${i}`, { path: file })).split("\n")[0]!;
			expect(h3).toMatch(/^\[.+#[0-9A-Fa-f]{4}\]$/);
			expect(h3).not.toBe(h1);
		}
	});
});

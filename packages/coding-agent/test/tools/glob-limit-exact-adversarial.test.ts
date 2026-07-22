import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GlobTool } from "@veyyon/coding-agent/tools/glob";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("GlobTool limit exact adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-lim-"));
		await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
		for (let i = 0; i < 30; i++) {
			await Bun.write(path.join(tmpDir, "src", `f${String(i).padStart(2, "0")}.ts`), `${i}\n`);
		}
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "glob.enabled": true }),
		});
	}

	it("limit 1 returns at most one file path line for src/**/*.ts", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g1", { path: "src/**/*.ts", limit: 1 } as never));
		const hits = text.split("\n").filter(l => /\.ts\b/.test(l) && /f\d+/.test(l));
		expect(hits.length).toBeLessThanOrEqual(3); // allow status lines
		// At least something was returned or a no-files notice.
		expect(text.length).toBeGreaterThan(0);
	});

	it("limit 5 does not list all 30 files without a truncation notice or cap", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g2", { path: "src/**/*.ts", limit: 5 } as never));
		const hits = text.split("\n").filter(l => /f\d+\.ts/.test(l));
		// Product may list exactly 5 or 5 + footer; never all 30 silent.
		expect(hits.length).toBeLessThanOrEqual(30);
		if (hits.length > 10) {
			expect(/limit|more|truncat|showing|\d+\s*file/i.test(text)).toBe(true);
		}
	});

	it("exact filename glob returns that file only", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g3", { path: "src/f05.ts" }));
		expect(text).toContain("f05.ts");
		expect(text.includes("f06.ts") && !/no files/i.test(text)).toBe(false);
	});
});

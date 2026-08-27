/**
 * WHY THIS SUITE EXISTS
 *
 * THE DEFECT IT CLOSES. `@path` expansion bounded a mentioned file with a bare
 * `truncateHead(textContent)`, so the window was the compiled 50KB constant and
 * `tools.artifactSpillThreshold` could not reach it. A mention is billed on
 * every later request exactly like a tool result, and lowering the setting
 * moved bash, eval, ssh, read and the centralized spill while leaving mentions
 * at 50KB, with two notices quoting the constant instead of the budget in
 * effect.
 *
 * THE CLASS. Any model-visible window priced against a compiled constant
 * rather than through `inlineBudgetFor`, the one owner of how many bytes a
 * result may carry. The three windows a mention has are all covered here: the
 * file body, the over-long first line, and a mentioned directory's listing.
 *
 * WHAT IT DOES NOT CATCH. The wording of a notice beyond the byte figure it
 * names, image mentions (bounded by pixel dimensions, not this budget), and a
 * caller that hands over a pricing source carrying no settings, which resolves
 * to the compiled default by design. The type system carries the rest: the
 * pricing source is a required positional parameter, so a caller cannot omit it
 * and silently take the constant.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { FileMentionMessage } from "@veyyon/coding-agent/session/messages";
import { generateFileMentionMessages } from "@veyyon/coding-agent/utils/file-mentions";
import { removeWithRetries } from "@veyyon/utils";

const LINE_WIDTH = 200;
const LINE_COUNT = 1_200;
const WIDE_LINE_BYTES = 300 * 1024;

function pricing(kb: number): { settings: Settings } {
	return { settings: Settings.isolated({ "tools.artifactSpillThreshold": kb }) };
}

async function mentionBody(cwd: string, target: string, kb: number): Promise<string> {
	const messages = await generateFileMentionMessages([target], cwd, pricing(kb));
	const message = messages[0];
	if (message?.role !== "fileMention") throw new Error(`no mention message for ${target}`);
	const file = (message as FileMentionMessage).files[0];
	if (!file) throw new Error(`no mention file for ${target}`);
	return file.content;
}

let dir: string;

describe("a mentioned file costs what a tool result may cost", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "mention-budget-"));
		const line = "x".repeat(LINE_WIDTH);
		await fs.writeFile(path.join(dir, "wide.txt"), `${Array.from({ length: LINE_COUNT }, () => line).join("\n")}\n`);
		await fs.writeFile(path.join(dir, "one-long-line.txt"), "y".repeat(WIDE_LINE_BYTES));
		await fs.mkdir(path.join(dir, "many"), { recursive: true });
		for (let index = 0; index < 400; index += 1) {
			await fs.writeFile(path.join(dir, "many", `entry-${index}-${"n".repeat(120)}.txt`), "z");
		}
	});

	afterAll(async () => {
		await removeWithRetries(dir);
	});

	it("holds a mentioned file body to the configured budget", async () => {
		const small = Buffer.byteLength(await mentionBody(dir, "wide.txt", 8), "utf-8");
		const large = Buffer.byteLength(await mentionBody(dir, "wide.txt", 64), "utf-8");

		expect(small).toBeLessThan(8 * 1024 + LINE_WIDTH * 3);
		expect(large).toBeGreaterThan(small * 4);
		expect(large).toBeLessThan(64 * 1024 + LINE_WIDTH * 3);
	});

	it("states the lines it showed and the selector that pages the rest", async () => {
		const body = await mentionBody(dir, "wide.txt", 8);

		expect(body).toContain(`of ${LINE_COUNT + 1}. Use :`);
		expect(body).toMatch(/\[Showing lines 1-\d+ of \d+\. Use :\d+ to continue\]/);
	});

	it("names the budget in effect when one line exceeds it", async () => {
		const body = await mentionBody(dir, "one-long-line.txt", 8);

		expect(body).toContain("exceeds 8.0KB limit");
		expect(body).not.toContain("50.0KB");
		expect(Buffer.byteLength(body, "utf-8")).toBeLessThan(8 * 1024 + 200);
	});

	it("holds a mentioned directory listing to the same budget", async () => {
		const small = await mentionBody(dir, "many", 8);
		const large = await mentionBody(dir, "many", 64);

		expect(small).toContain("8.0KB limit reached");
		expect(Buffer.byteLength(small, "utf-8")).toBeLessThan(8 * 1024 + 300);
		expect(Buffer.byteLength(large, "utf-8")).toBeGreaterThan(Buffer.byteLength(small, "utf-8") * 4);
	});

	it("leaves a mention inside the budget whole and unannotated", async () => {
		await fs.writeFile(path.join(dir, "short.txt"), "alpha\nbeta\n");
		const body = await mentionBody(dir, "short.txt", 8);

		expect(body).toBe("alpha\nbeta\n");
	});

	it("takes the compiled default when the pricing source carries no settings", async () => {
		const messages = await generateFileMentionMessages(["wide.txt"], dir, {});
		const message = messages[0];
		if (message?.role !== "fileMention") throw new Error("no mention message");
		const body = (message as FileMentionMessage).files[0]?.content ?? "";

		// 50KB, the compiled default, is what an unconfigured session pays and is
		// what this fixture is sized to exceed.
		const bytes = Buffer.byteLength(body, "utf-8");
		expect(bytes).toBeGreaterThan(48 * 1024);
		expect(bytes).toBeLessThan(51 * 1024);
	});
});

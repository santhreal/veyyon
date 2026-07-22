import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function bashSession(cwd: string) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "bash-printf",
		allocateOutputArtifact: async kind => ({
			id: `${kind}-1`,
			path: path.join(cwd, `${kind}-1.txt`),
		}),
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("");
}

describe("BashTool printf and wc adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-printf-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("printf without newline still returns the body", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("p1", { command: "printf 'no-nl'", timeout: 15 });
		expect(textOf(result)).toContain("no-nl");
	});

	it("wc -l reports exact line count for a written file", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await Bun.write(path.join(tmpDir, "lines.txt"), "a\nb\nc\n");
		const result = await tool.execute("w1", { command: "wc -l < lines.txt", timeout: 15 });
		expect(textOf(result)).toMatch(/\b3\b/);
	});

	it("seq output includes first and last numbers", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("s1", { command: "seq 1 5", timeout: 15 });
		const text = textOf(result);
		expect(text).toContain("1");
		expect(text).toContain("5");
		expect(text).toContain("3");
	});

	it("test -f succeeds for an existing file via exit code 0", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await Bun.write(path.join(tmpDir, "exists.txt"), "x");
		const result = await tool.execute("t1", {
			command: "test -f exists.txt && printf ok",
			timeout: 15,
		});
		expect(textOf(result)).toContain("ok");
	});
});

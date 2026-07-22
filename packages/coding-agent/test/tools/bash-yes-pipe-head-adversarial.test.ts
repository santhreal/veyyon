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
		getSessionId: () => "bash-yes",
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

describe("BashTool yes|head and bounded generators", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-yes-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("yes piped to head -n 3 produces three y lines", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("y1", {
			command: "yes | head -n 3",
			timeout: 15,
		});
		const text = textOf(result);
		const ys = text.split("\n").filter(l => l.trim() === "y");
		expect(ys.length).toBeGreaterThanOrEqual(3);
	});

	it("head -c bounds byte output", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("h1", {
			command: "printf '%s' 'abcdefghijklmnopqrstuvwxyz' | head -c 5",
			timeout: 15,
		});
		expect(textOf(result)).toContain("abcde");
		expect(textOf(result).includes("z")).toBe(false);
	});
});

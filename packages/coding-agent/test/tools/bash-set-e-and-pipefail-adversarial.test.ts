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
		getSessionId: () => "bash-sete",
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

describe("BashTool set -e and compound adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-sete-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("set -e stops after a failing command so marker file is absent", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const marker = path.join(tmpDir, "should-not");
		await tool.execute("e1", {
			command: `set -e; false; printf x > '${marker}'`,
			timeout: 15,
		});
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("subshell (false) does not abort outer script without set -e", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e2", {
			command: "(false); printf 'after\\n'",
			timeout: 15,
		});
		expect(textOf(result)).toContain("after");
	});

	it("brace group runs both printf calls", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e3", {
			command: "{ printf 'a'; printf 'b\\n'; }",
			timeout: 15,
		});
		expect(textOf(result)).toContain("a");
		expect(textOf(result)).toContain("b");
	});
});

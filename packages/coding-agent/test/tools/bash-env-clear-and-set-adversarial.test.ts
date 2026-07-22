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
		getSessionId: () => "bash-env2",
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

describe("BashTool env set/unset adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-env2-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("export then printf sees the variable", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e1", {
			command: "export FOO=bar; printf '%s\\n' \"$FOO\"",
			timeout: 15,
		});
		expect(textOf(result)).toContain("bar");
	});

	it("unset removes a previously exported variable in the same shell", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e2", {
			command: "export FOO=bar; unset FOO; printf '<%s>\\n' \"${FOO-missing}\"",
			timeout: 15,
		});
		expect(textOf(result)).toContain("missing");
	});

	it("HOME is non-empty in the bash environment", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e3", {
			command: "printf '%s\\n' \"$HOME\"",
			timeout: 15,
		});
		expect(textOf(result).trim().length).toBeGreaterThan(0);
	});
});

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
		getSessionId: () => "bash-cd",
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

describe("BashTool cd and nested pwd adversarial", () => {
	let tmpDir: string;
	let child: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cd-"));
		child = path.join(tmpDir, "child");
		await fs.mkdir(child);
		await Bun.write(path.join(child, "marker.txt"), "in-child\n");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("cd into child then cat marker works in one command", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("c1", {
			command: "cd child && cat marker.txt",
			timeout: 15,
		});
		expect(textOf(result)).toContain("in-child");
	});

	it("cd does not permanently change session cwd for the next command", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await tool.execute("c2a", { command: "cd child", timeout: 15 });
		// Next command still starts from session cwd.
		const result = await tool.execute("c2b", {
			command: "test -f child/marker.txt && printf 'still-root\\n'",
			timeout: 15,
		});
		expect(textOf(result)).toContain("still-root");
	});

	it("explicit cwd option runs in the child directory", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("c3", {
			command: "cat marker.txt",
			cwd: child,
			timeout: 15,
		});
		expect(textOf(result)).toContain("in-child");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Bash exit codes, pipes, env, and chaining — exact stdout and exit reporting.
 */

function bashSession(cwd: string) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "bash-exit",
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

describe("BashTool exit and env adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-exit-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("exit 0 success has empty or success-bearing output without exit-1 wording", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e0", { command: "true", timeout: 15 });
		const details = result.details as { exitCode?: number } | undefined;
		if (typeof details?.exitCode === "number") {
			expect(details.exitCode).toBe(0);
		}
		expect(textOf(result).toLowerCase().includes("exit 1")).toBe(false);
	});

	it("pipeline stdout is the final command output", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("pipe", {
			command: "printf 'one\\ntwo\\nthree\\n' | tail -n 1",
			timeout: 15,
		});
		expect(textOf(result)).toContain("three");
		expect(textOf(result).includes("one")).toBe(false);
	});

	it("env var set via export is visible to the next command", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		// Use export+semicolon so both POSIX sh and bash see the var (prefix assignment
		// is shell-dependent under the product's spawn shell).
		const result = await tool.execute("env", {
			command: "export VEY_TEST_VAR=hello-env; printf '%s\\n' \"$VEY_TEST_VAR\"",
			timeout: 15,
		});
		expect(textOf(result)).toContain("hello-env");
	});

	it("&& short-circuit skips the second command on failure", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const marker = path.join(tmpDir, "should-not-exist");
		await tool.execute("and", {
			command: `false && printf x > '${marker}'`,
			timeout: 15,
		});
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("|| runs the second command when the first fails", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("or", {
			command: "false || printf 'fallback\\n'",
			timeout: 15,
		});
		expect(textOf(result)).toContain("fallback");
	});

	it("writes and reads a file in the same command chain", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("rw", {
			command: "printf 'chain\\n' > chain.txt && cat chain.txt",
			timeout: 15,
		});
		expect(textOf(result)).toContain("chain");
		expect(await Bun.file(path.join(tmpDir, "chain.txt")).text()).toBe("chain\n");
	});

	it("pwd reports the session cwd", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("pwd", { command: "pwd", timeout: 15 });
		// Resolve both sides (macOS /var vs /private/var).
		const out = textOf(result).trim();
		const realTmp = await fs.realpath(tmpDir);
		const realOut = out ? await fs.realpath(out).catch(() => out) : out;
		expect(realOut === realTmp || out.includes(path.basename(tmpDir))).toBe(true);
	});
});

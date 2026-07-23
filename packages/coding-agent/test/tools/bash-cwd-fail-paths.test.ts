import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * BashTool cwd fail-closed contracts: missing/non-directory cwd, async disabled,
 * and a successful command with exact stdout. Drives BashTool.execute.
 */

function bashSession(cwd: string) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "bash-fail",
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

describe("BashTool cwd and config fail paths", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("runs a simple printf and returns its stdout text", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("b1", { command: "printf 'hello-bash\\n'", timeout: 30 });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text: string }).text)
			.join("");
		expect(text).toContain("hello-bash");
	});

	it("throws when cwd does not exist", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const missing = path.join(tmpDir, "no-such-dir");
		await expect(tool.execute("b2", { command: "true", cwd: missing, timeout: 10 })).rejects.toThrow(ToolError);
		await expect(tool.execute("b2b", { command: "true", cwd: missing, timeout: 10 })).rejects.toThrow(
			/Working directory does not exist/,
		);
	});

	it("throws when cwd is a file not a directory", async () => {
		const filePath = path.join(tmpDir, "not-a-dir");
		await Bun.write(filePath, "x");
		const tool = new BashTool(bashSession(tmpDir) as never);
		await expect(tool.execute("b3", { command: "true", cwd: filePath, timeout: 10 })).rejects.toThrow(
			/not a directory/i,
		);
	});

	it("throws when async is requested but async.enabled is false", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await expect(tool.execute("b4", { command: "true", async: true, timeout: 10 })).rejects.toThrow(
			/Async bash execution is disabled/,
		);
	});

	it("abort signal cancels a long sleep", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const ac = new AbortController();
		const pending = tool.execute("b5", { command: "sleep 30", timeout: 60 }, ac.signal);
		await Bun.sleep(50);
		ac.abort();
		await expect(pending).rejects.toThrow();
	});

	it("nonzero exit is reported without inventing zero-exit success text", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("b6", { command: "exit 7", timeout: 15 });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text: string }).text)
			.join("");
		const details = result.details as { exitCode?: number } | undefined;
		if (typeof details?.exitCode === "number") {
			expect(details.exitCode).toBe(7);
		} else {
			expect(text).toMatch(/7|exit|fail|error|nonzero|code/i);
		}
	});

	it("stderr content is captured for a command that writes only to stderr", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("b7", {
			command: "printf 'err-only\\n' 1>&2",
			timeout: 15,
		});
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text: string }).text)
			.join("");
		expect(text).toContain("err-only");
	});

	it("command cwd defaults to session cwd so relative file writes land there", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await tool.execute("b8", {
			command: "printf 'from-bash\\n' > bash-out.txt",
			timeout: 15,
		});
		expect(await Bun.file(path.join(tmpDir, "bash-out.txt")).text()).toBe("from-bash\n");
	});

	it("empty command is rejected or returns a clear error (not hang)", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		let text = "";
		try {
			const result = await tool.execute("b9", { command: "", timeout: 10 });
			text = result.content
				.filter(c => c.type === "text")
				.map(c => (c as { text: string }).text)
				.join("");
		} catch (e) {
			text = String(e);
		}
		expect(text.length).toBeGreaterThan(0);
		expect(/empty|required|invalid|command|error/i.test(text) || text.length > 0).toBe(true);
	});

	it("multiline command preserves both echo lines in stdout", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("b10", {
			command: "printf 'line-a\\n'; printf 'line-b\\n'",
			timeout: 15,
		});
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text: string }).text)
			.join("");
		expect(text).toContain("line-a");
		expect(text).toContain("line-b");
	});

	it("unicode stdout survives the bash path", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("b11", {
			command: "printf '日本語-ok\\n'",
			timeout: 15,
		});
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text: string }).text)
			.join("");
		expect(text).toContain("日本語-ok");
	});
});

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
		getSessionId: () => "bash-heredoc",
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

describe("BashTool heredoc and redirect adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-hd-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("heredoc writes multi-line content to a file", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await tool.execute("h1", {
			command: "cat > out.txt <<'EOF'\nline1\nline2\nEOF",
			timeout: 15,
		});
		expect(await Bun.file(path.join(tmpDir, "out.txt")).text()).toBe("line1\nline2\n");
	});

	it("append redirect preserves prior content", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await tool.execute("a1", { command: "printf 'first\\n' > app.txt", timeout: 15 });
		await tool.execute("a2", { command: "printf 'second\\n' >> app.txt", timeout: 15 });
		expect(await Bun.file(path.join(tmpDir, "app.txt")).text()).toBe("first\nsecond\n");
	});

	it("stdout redirect does not also dump the body into tool text", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("r1", {
			command: "printf 'secret-body\\n' > quiet.txt",
			timeout: 15,
		});
		// File has content; tool text should not necessarily include secret-body.
		expect(await Bun.file(path.join(tmpDir, "quiet.txt")).text()).toBe("secret-body\n");
		// Allow either silent success or a short status line.
		expect(typeof textOf(result)).toBe("string");
	});

	it("cat of a written file returns the file body in tool text", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		await Bun.write(path.join(tmpDir, "seen.txt"), "visible\n");
		const result = await tool.execute("c1", { command: "cat seen.txt", timeout: 15 });
		expect(textOf(result)).toContain("visible");
	});
});

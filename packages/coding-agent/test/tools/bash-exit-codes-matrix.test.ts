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
		getSessionId: () => "bash-ex",
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

describe("BashTool exit codes matrix", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-ex-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("exit N reports N in details when present for several codes", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		for (const code of [0, 1, 2, 7, 127]) {
			const result = await tool.execute(`e${code}`, {
				command: `exit ${code}`,
				timeout: 15,
			});
			const details = result.details as { exitCode?: number } | undefined;
			if (typeof details?.exitCode === "number") {
				expect(details.exitCode).toBe(code);
			} else {
				// Soft path: status text may mention the code.
				const text = result.content
					.filter(c => c.type === "text")
					.map(c => (c as { text: string }).text)
					.join("");
				expect(text.includes(String(code)) || code === 0).toBe(true);
			}
		}
	});
});

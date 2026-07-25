import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

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

	/**
	 * `exit N` puts N on `details.exitCode`, with no accepted alternative.
	 *
	 * This test used to branch: if `details.exitCode` was a number it compared it,
	 * and otherwise it fell back to looking for the digits anywhere in the output
	 * text. That made it pass whether or not the field was populated, which is the
	 * one thing it was there to prove, and the fallback was weaker still since
	 * "127" appears in plenty of unrelated output. It is strict now.
	 *
	 * Zero is excluded from the table because success deliberately carries no code
	 * at all; that contract, along with not-found and signal death, is covered in
	 * `bash-failure-classes-distinguishable.test.ts`.
	 */
	it("puts the exact code on details.exitCode for every non-zero exit", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		for (const code of [1, 2, 7, 127]) {
			const result = await tool.execute(`e${code}`, {
				command: `exit ${code}`,
				timeout: 15,
			});
			const details = result.details as { exitCode?: number } | undefined;
			expect(details?.exitCode).toBe(code);
		}
	});
});

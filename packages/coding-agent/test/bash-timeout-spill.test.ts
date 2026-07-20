import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES } from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/bash";

// TW-7: a command that emits more than the inline byte budget and then times
// out (or is cancelled) must route its output through the SAME artifact-spill
// path a completed command uses. Before the fix the abort/timeout error carried
// the full untruncated buffer, which then rode along in context for every later
// turn (a measured 72KB timeout result cost ~7M token-turns of cacheRead).

const HEAD_SENTINEL = "SENTINEL_HEAD_7f3a";
const TAIL_SENTINEL = "SENTINEL_TAIL_9c2b";

function makeArtifactSession(artifactDir: string): {
	session: ToolSession;
	idToPath: Map<string, string>;
} {
	const idToPath = new Map<string, string>();
	let counter = 0;
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "test-session",
		allocateOutputArtifact: (kind: string) => {
			counter += 1;
			const id = `${kind}-${counter}`;
			const filePath = path.join(artifactDir, `${id}.txt`);
			idToPath.set(id, filePath);
			return { path: filePath, id };
		},
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
	} as unknown as ToolSession;
	return { session, idToPath };
}

describe("BashTool timeout output spill (TW-7)", () => {
	it("bounds a >50KB timed-out command and offloads the full output to an artifact", async () => {
		const artifactDir = mkdtempSync(path.join(tmpdir(), "bash-timeout-spill-"));
		const { session, idToPath } = makeArtifactSession(artifactDir);
		const tool = new BashTool(session);

		// Emit ~64KB (over DEFAULT_MAX_BYTES = 50KB) framed by distinctive
		// sentinels, then hang past the 1s deadline so the executor kills it.
		const command = `printf '${HEAD_SENTINEL}\\n'; yes PADPADPADPADPADPAD | head -c 65536; printf '\\n${TAIL_SENTINEL}\\n'; sleep 10`;

		let thrown: unknown;
		try {
			await tool.execute("call-timeout", { command, timeout: 1 });
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		const messageBytes = Buffer.byteLength(message, "utf-8");

		// The inline error body is bounded to the same budget as a completed
		// command, NOT the full ~64KB it produced.
		expect(messageBytes).toBeLessThan(DEFAULT_MAX_BYTES);

		// It still tells the model the command timed out and points at the artifact.
		expect(message).toContain("timed out");
		expect(message).toContain("artifact://");
		expect(message).toContain(HEAD_SENTINEL);

		// The artifact holds the FULL output, both sentinels, and is larger than
		// the inline budget: nothing was lost, only moved out of the wire body.
		const match = message.match(/artifact:\/\/([^\]\s]+)/);
		expect(match).not.toBeNull();
		const artifactId = match![1];
		const artifactPath = idToPath.get(artifactId);
		expect(artifactPath).toBeDefined();
		const artifactText = await readFile(artifactPath!, "utf-8");
		expect(Buffer.byteLength(artifactText, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
		expect(artifactText).toContain(HEAD_SENTINEL);
		expect(artifactText).toContain(TAIL_SENTINEL);
	}, 15_000);

	it("leaves a small timed-out command's output inline with no artifact footer", async () => {
		const artifactDir = mkdtempSync(path.join(tmpdir(), "bash-timeout-small-"));
		const { session } = makeArtifactSession(artifactDir);
		const tool = new BashTool(session);

		// Tiny output then hang: under the budget, so enforceInlineByteCap is a
		// no-op and the body stays verbatim with no spill footer.
		const command = `printf 'small-marker-4d1e\\n'; sleep 10`;

		let thrown: unknown;
		try {
			await tool.execute("call-timeout-small", { command, timeout: 1 });
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("small-marker-4d1e");
		expect(message).toContain("timed out");
		expect(message).not.toContain("artifact://");
		expect(message).not.toContain("elided");
	}, 15_000);
});

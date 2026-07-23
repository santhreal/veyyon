import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { makeToolSession } from "./helpers/tool-session";

// NOTE: this suite deliberately does NOT call the global `Settings.init(...)`.
// That mutates the process-wide `Settings` singleton, and because `Settings.init`
// is guarded to initialize once, a later `Settings.init({ agentDir })` in another
// test file would be no-op'd and silently read the wrong (in-memory) instance —
// which broke session-workdir-settings-ui's persist test when both ran in one bun
// process. The session's own `Settings.isolated()` is all this test needs.

// WHY THIS SUITE EXISTS (BACKLOG DOG-5)
// -------------------------------------
// Writing to a read-only internal-URL scheme used to fail with a dead-end message
// ("use the protocol-specific tool for mutations") that never named the tool, so a
// dogfood agent that tried `write memory://...` had no next step. The error now
// names the tool that DOES mutate the scheme (memory:// -> memory_edit). This test
// locks that guidance in so the message cannot regress back to the vague form.

function createSession(cwd: string): ToolSession {
	return makeToolSession({
		cwd,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
		enableLsp: false,
	});
}

describe("write tool: read-only internal-URL schemes name their mutation tool", () => {
	it("rejects a memory:// write and names memory_edit as the tool to use", async () => {
		const tool = new WriteTool(createSession("/tmp"));

		await expect(tool.execute("call-1", { path: "memory://test.md", content: "hi" })).rejects.toThrow(/memory_edit/);
	});
});

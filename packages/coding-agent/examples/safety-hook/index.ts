// @ts-nocheck — example file; install @veyyon/coding-agent before running
import type { ExtensionAPI } from "@veyyon/coding-agent";

export default function safetyHook(pi: ExtensionAPI) {
	pi.on("tool_call", async event => {
		if (event.toolName !== "bash") return;

		const command = String((event.input as { command?: unknown }).command ?? "");

		if (/\brm\s+-rf\s+\//.test(command)) {
			return {
				block: true,
				reason: "safety-hook: refusing to delete root filesystem (rm -rf /)",
			};
		}
	});
}

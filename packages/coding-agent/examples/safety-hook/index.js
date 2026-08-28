export default function safetyHook(pi) {
    pi.on("tool_call", async (event) => {
        if (event.toolName !== "bash")
            return;
        const command = String(event.input.command ?? "");
        if (/\brm\s+-rf\s+\//.test(command)) {
            return {
                block: true,
                reason: "safety-hook: refusing to delete root filesystem (rm -rf /)",
            };
        }
    });
}

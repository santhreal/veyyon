import { createAgentSession, SessionManager } from "@veyyon/coding-agent";
const loggingHook = api => {
    api.on("agent_start", async () => {
        console.log("[Hook] Agent starting");
    });
    api.on("tool_call", async (event) => {
        console.log(`[Hook] Tool: ${event.toolName}`);
        return undefined; // Don't block
    });
    api.on("agent_end", async (event) => {
        console.log(`[Hook] Done, ${event.messages.length} messages`);
    });
};
const safetyHook = api => {
    api.on("tool_call", async (event) => {
        if (event.toolName === "bash") {
            const cmd = event.input.command ?? "";
            if (cmd.includes("rm -rf")) {
                return { block: true, reason: "Dangerous command blocked" };
            }
        }
        return undefined;
    });
};
const { session } = await createAgentSession({
    extensions: [loggingHook, safetyHook],
    sessionManager: SessionManager.inMemory(),
});
session.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
    }
});
await session.prompt("List files in the current directory.");
console.log();

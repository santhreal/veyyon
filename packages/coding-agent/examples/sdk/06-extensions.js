import { createAgentSession, SessionManager } from "@veyyon/coding-agent";
const { session } = await createAgentSession({
    additionalExtensionPaths: ["./my-logging-extension.ts", "./my-safety-extension.ts"],
    sessionManager: SessionManager.inMemory(),
});
session.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
    }
});
await session.prompt("List files in the current directory.");
console.log();

export default function (pi) {
    const { z } = pi.zod;
    // Access the logger for debugging
    pi.logger.debug("API demo extension loaded");
    pi.registerTool({
        name: "api_demo",
        label: "API Demo",
        description: "Demonstrates ExtensionAPI capabilities: logger, zod, and pi module access",
        parameters: z.object({
            message: z.string().describe("Test message"),
            logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
        }),
        // `registerTool` takes the signal BEFORE `onUpdate`; a custom tool loaded from
        // `tools/` takes them the other way round. Copying one order into the other
        // place types `ctx` as the update callback and every `ctx.*` access fails.
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const { message, logLevel } = params;
            // Use logger at specified level
            pi.logger[logLevel]("API demo tool executed", { message, logLevel });
            // Access pi module utilities
            const { logger: piLogger } = pi.pi;
            piLogger.debug("Accessed pi module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });
            // Get session information
            const sessionInfo = `Session: ${ctx.sessionManager.getSessionFile()}`;
            const modelInfo = ctx.model ? `Model: ${ctx.model.id}` : "Model: none";
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `API Demo Tool executed successfully!`,
                            ``,
                            `Message: ${message}`,
                            `Log Level: ${logLevel}`,
                            ``,
                            `Features demonstrated:`,
                            `1. ✓ Logger access via pi.logger`,
                            `2. ✓ Zod access via pi.zod`,
                            `3. ✓ Pi module access via pi.pi`,
                            ``,
                            `Context:`,
                            `- ${sessionInfo}`,
                            `- ${modelInfo}`,
                            `- CWD: ${ctx.cwd}`,
                        ].join("\n"),
                    },
                ],
                details: {
                    message,
                    logLevel,
                    sessionFile: ctx.sessionManager.getSessionFile(),
                    modelId: ctx.model?.id,
                },
            };
        },
    });
    // Demonstrate event handling with logger
    pi.on("session_start", async () => {
        pi.logger.debug("Session started", { extension: "api-demo" });
    });
    pi.on("agent_start", async () => {
        pi.logger.debug("Agent started", { extension: "api-demo" });
    });
}

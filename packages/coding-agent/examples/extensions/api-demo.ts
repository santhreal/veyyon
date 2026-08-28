import type { ExtensionAPI } from "@veyyon/coding-agent";

export default function (pi: ExtensionAPI) {
	const { z } = pi.zod;

	pi.logger.debug("API demo extension loaded");

	pi.registerTool({
		name: "api_demo",
		label: "API Demo",
		description: "Demonstrates ExtensionAPI capabilities: logger, zod, and pi module access",
		parameters: z.object({
			message: z.string().describe("Test message"),
			logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { message, logLevel } = params;

			pi.logger[logLevel]("API demo tool executed", { message, logLevel });

			const { logger: piLogger } = pi.pi;
			piLogger.debug("Accessed pi module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });

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

	pi.on("session_start", async () => {
		pi.logger.debug("Session started", { extension: "api-demo" });
	});

	pi.on("agent_start", async () => {
		pi.logger.debug("Agent started", { extension: "api-demo" });
	});
}

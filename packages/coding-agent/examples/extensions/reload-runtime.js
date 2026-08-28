export default function (pi) {
    const { z } = pi.zod;
    pi.registerCommand("reload-runtime", {
        description: "Reload extensions, skills, prompts, and themes",
        handler: async (_args, ctx) => {
            await ctx.reload();
            return;
        },
    });
    pi.registerTool({
        name: "reload_runtime",
        label: "Reload Runtime",
        description: "Reload extensions, skills, prompts, and themes",
        parameters: z.object({}),
        async execute() {
            pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
            return {
                content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
                details: {},
            };
        },
    });
}

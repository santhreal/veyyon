import * as fs from "node:fs";
import type { HookAPI } from "@veyyon/coding-agent";

export default function (pi: HookAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const triggerFile = "/tmp/agent-trigger.txt";

		fs.watch(triggerFile, async () => {
			try {
				const content = (await Bun.file(triggerFile).text()).trim();
				if (content) {
					pi.sendMessage(
						{
							customType: "file-trigger",
							content: `External trigger: ${content}`,
							display: true,
						},
						{ triggerTurn: true },
					);
					await Bun.write(triggerFile, ""); // Clear after reading
				}
			} catch {}
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
	});
}

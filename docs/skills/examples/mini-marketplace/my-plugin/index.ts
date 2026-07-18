// @ts-nocheck — example file; install @veyyon/coding-agent before running
import type { ExtensionAPI } from "@veyyon/coding-agent";

export default function myPlugin(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}

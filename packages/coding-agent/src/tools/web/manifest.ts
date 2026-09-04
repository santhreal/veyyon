/**
 * What the web domain contributes.
 *
 * The two tools that reach the network as a user would: a real Chromium tab and the GitHub client.
 * URL reads use the same lazy boundary without registering a separate tool.
 *
 * The factories stay dynamic for the reason the whole dispatch table does — a session that never
 * opens a tab never parses puppeteer or the stealth payloads — and this file is one of the six the
 * dynamic-import baseline names for it.
 */
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import type { BuiltinToolName } from "../core/builtin-names";
import { ToolError } from "../core/tool-errors";
import type { ToolFactory, ToolSession } from "../index";

export const webTools = {
	browser: async s => new (await import("./browser")).BrowserTool(s),
	github: async s => (await import("./gh")).GithubTool.createIf(s),
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

export const webDomain = { domain: "web", tools: webTools } satisfies ToolDomainManifest<ToolFactory>;

/** Load URL execution only for an enabled URL operation, never for parsing or rendering. */
export async function loadUrlReader(session: ToolSession) {
	if (!session.settings.get("fetch.enabled")) {
		throw new ToolError("URL reads are disabled by settings.");
	}
	return import("./fetch");
}

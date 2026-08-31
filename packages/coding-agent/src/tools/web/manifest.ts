/**
 * What the web domain contributes.
 *
 * The two tools that reach the network as a user would: a real Chromium tab and the GitHub client.
 * `fetch` is not one of them — it is the reader `read` and the search tools call for a URL, so it
 * lives here as a module the other domains import rather than as a tool of its own.
 *
 * The factories stay dynamic for the reason the whole dispatch table does — a session that never
 * opens a tab never parses puppeteer or the stealth payloads — and this file is one of the six the
 * dynamic-import baseline names for it.
 */
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import type { BuiltinToolName } from "../core/builtin-names";
import type { ToolFactory } from "../index";

export const webTools = {
	browser: async s => new (await import("./browser")).BrowserTool(s),
	github: async s => (await import("./gh")).GithubTool.createIf(s),
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

export const webDomain: ToolDomainManifest<ToolFactory> = { domain: "web", tools: webTools };

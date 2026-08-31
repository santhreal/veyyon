/**
 * Names Anthropic's API uses on the wire that both packages have to spell the same way.
 *
 * `web_search` is a SERVER-side tool: the request declares it and the response comes back carrying blocks
 * named after it, so one module sends the name and another matches it. `@veyyon/coding-agent`'s Anthropic
 * search provider declared it as `WEB_SEARCH_TOOL_NAME` and `@veyyon/ai`'s Anthropic provider as
 * `UMANS_WEBSEARCH_TOOL_NAME`, in two packages, for one string Anthropic decides.
 *
 * The failure if they drift is a miss rather than an error: the provider stops recognising the tool-use blocks
 * it asked for, so the search runs, the results come back, and nothing renders them.
 *
 * This module has no imports.
 */

/** Anthropic's server-side web-search tool, as named in a request and in the response blocks it produces. */
export const ANTHROPIC_WEB_SEARCH_TOOL = "web_search";

/**
 * The Claude Code version this client identifies itself as.
 *
 * WHY IT LIVES HERE AND NOT BESIDE THE PROVIDER. Three modules build a
 * user-agent from it and they deliberately build DIFFERENT ones: the provider
 * sends `claude-cli/<version> (external, local-agent, agent-sdk/<sdk>)`, the
 * usage client sends `claude-cli/<version> (external, cli)`, and the OAuth
 * bootstrap sends `claude-code/<version>`. Three shapes, one version, and the
 * version is the part that has to agree.
 *
 * It had been declared in `@veyyon/ai`'s Anthropic provider, which reaches 310
 * modules: the whole streaming stack, the model catalogue and the error
 * taxonomy. The OAuth controller and the usage client wanted nothing else from
 * there, so each paid 310 modules to know a version string. This module has no
 * imports.
 *
 * A drift here is not an error. The requests still go out, they simply carry a
 * fingerprint that does not match the one the other two send, which is exactly
 * the inconsistency a server-side check looks for.
 */
export const CLAUDE_CODE_VERSION = "2.1.165";

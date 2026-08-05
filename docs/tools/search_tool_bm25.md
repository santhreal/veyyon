# search_tool_bm25

> Search the hidden tool-discovery index and activate the top matches for the current session.

## Source
- Entry: `packages/coding-agent/src/tools/search-tool-bm25.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search-tool-bm25.md`
- Key collaborators:
  - `packages/coding-agent/src/tool-discovery/tool-index.ts`: discoverable-tool metadata and BM25 index/search.
  - `packages/coding-agent/src/session/agent-session.ts`: session discovery mode, corpus assembly, activation, cache invalidation.
  - `packages/coding-agent/src/sdk.ts`: initial hiding of discoverable built-ins and prompt-time discoverable summary.
  - `packages/coding-agent/src/tools/index.ts`: tool-session discovery hooks, essential/discoverable load modes, registry wiring.
  - `packages/coding-agent/src/config/settings-domains/tools.ts`: `tools.discoveryMode` and legacy `mcp.discoveryMode` settings.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Natural-language or keyword query. Trimmed before search; empty-after-trim is rejected. |
| `limit` | `integer` | No | Max matches to return and activate. Minimum `1`. Defaults to `8` (`DEFAULT_LIMIT`). |

## Outputs
- Single-shot `AgentToolResult`.
- Model-visible `content` is one text part containing JSON with:

```json
{"query":"...","activated_tools":["..."],"match_count":2,"total_tools":17}
```

- Runtime-only `details` carries the ranked matches used by the TUI renderer:
  - `query`, `limit`, `total_tools`
  - `activated_tools`: tool names activated by this call
  - `active_selected_tools`: cumulative discovered-tool selections still active
  - `tools`: array of match objects with
    - `name`
    - `label`
    - `description` (`tool.summary`; this is the only snippet-like field)
    - optional `server_name`
    - optional `mcp_tool_name`
    - `schema_keys`
    - `score` rounded to 6 decimals
- The renderer shows a status line plus up to 5 collapsed tree items by default (`COLLAPSED_MATCH_LIMIT`), each with label, optional server name, score to 3 decimals, and truncated description. The ranked match list is not serialized into `content`.

## Flow
1. `SearchToolBm25Tool.createIf()` in `packages/coding-agent/src/tools/search-tool-bm25.ts` exposes the tool for explicit discovery modes (`"mcp-only"` / `"all"`) or legacy `mcp.discoveryMode === true`. The default `"auto"` mode is resolved later by `createAgentSession()` after MCP/extension tools are registered, which also injects the tool for local discovery.
2. `description` is rendered from `packages/coding-agent/src/prompts/tools/search-tool-bm25.md` via `renderSearchToolBm25Description()`, using the current discoverable-tool list plus per-server summary/count.
3. `execute()` re-checks capability and settings:
   - missing discovery hooks -> `ToolError("Tool discovery is unavailable in this session.")`
   - discovery disabled -> `ToolError("Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.")`
4. `query` is trimmed and validated; `limit` is defaulted/validated.
5. `getDiscoverableToolSearchIndexForExecution()` fetches the cached generic search index from the session when available, otherwise rebuilds an index from the current discoverable-tool list.
6. `getSelectedToolNames()` reads the current discovered selections so already-selected tools can be excluded from fresh results.
7. `searchDiscoverableTools()` in `packages/coding-agent/src/tool-discovery/tool-index.ts` tokenizes the query, scores every document with BM25, sorts by descending score then `tool.name`, and returns up to `searchIndex.documents.length` results; `execute()` then filters already-selected names and slices to `limit`.
8. If any matches remain, `activateTools()` activates all matched tool names through `session.activateDiscoveredTools()` or legacy `activateDiscoveredMCPTools()`.
9. `details` is assembled from the activated names, current selected names, corpus size, and formatted matches; `content` is reduced to the compact JSON summary from `buildSearchToolBm25Content()`.
10. `searchToolBm25Renderer` renders either:
   - the structured `details` view, or
   - a fallback text-only warning block if `details` is absent.

## Modes / Variants
- Discovery-mode gating:
  - `tools.discoveryMode = "auto"` (default): searches hidden discoverable built-ins and eligible first-party heavyweight local tools. It also hides and searches MCP tools when the registered tool set has more than 40 tools.
  - `tools.discoveryMode = "all"`: searches hidden discoverable built-ins, first-party heavyweight tools such as `generate_image`, and hidden MCP tools at every tool-set size.
    - Two built-ins survive local hiding under `"auto"` and `"all"` because a request without them contradicts the prompt: `todo` when `todo.eager` is not `default` (a forced named tool_choice must reference a tool that is present, or the provider rejects the request), and `task` at `subagent.delegation` `preferred` or `required`. At `allowed` `task` is hidden like the rest and you activate it from here.
  - `tools.discoveryMode = "mcp-only"`: searches hidden MCP tools only.
  - legacy `mcp.discoveryMode = true`: same as MCP-only.
- Search-index source:
  - generic cached discoverable index from the session (`getDiscoverableToolSearchIndex()`)
  - rebuilt ad hoc from the current discoverable-tool list when the cache path fails
- Activation backend:
  - generic `activateDiscoveredTools()`
  - legacy `activateDiscoveredMCPTools()` fallback

## Side Effects
- Session state
  - Adds matched tools to the active session tool set through `activateDiscoveredTools()` / `activateDiscoveredMCPTools()`.
  - Updates discovered-tool selection state so repeated searches accumulate selections instead of replacing them.
  - Invalidates the cached discoverable search index when newly activated built-ins change the hidden corpus (`packages/coding-agent/src/session/agent-session.ts`).
  - Tool availability changes before the next model call in the same turn; the prompt text says this explicitly.
- User-visible prompts / interactive UI
  - The tool description includes discoverable server summaries and total discoverable-tool count.
  - The TUI renderer shows ranked matches, but the model-visible text summary does not.

## Limits & Caps
- Default result cap: `8` (`DEFAULT_LIMIT` in `packages/coding-agent/src/tools/search-tool-bm25.ts`).
- `limit` must be a positive integer; no tool-level upper bound beyond corpus size.
- Renderer collapsed list cap: `5` (`COLLAPSED_MATCH_LIMIT`).
- Renderer truncation widths:
  - label: `72` chars (`MATCH_LABEL_LEN`)
  - description: `96` chars (`MATCH_DESCRIPTION_LEN`)
- BM25+ parameters in `packages/coding-agent/src/tool-discovery/tool-index.ts`:
  - `BM25_K1 = 1.2`
  - `BM25_B = 0.75`
  - `BM25_DELTA = 1.0`
- Weighted corpus fields (`FIELD_WEIGHTS`):
  - `name`: `6`
  - `label`: `4`
  - `mcpToolName`: `4`
  - `serverName`: `2`
  - `summary`: `2`
  - each `schemaKey`: `1`
- Summary fallback length for discoverable metadata: first `200` chars of `description` when no explicit summary exists (`getDiscoverableTool()` in `packages/coding-agent/src/tool-discovery/tool-index.ts`).

## Errors
- `execute()` throws `ToolError` for unavailable discovery hooks, disabled discovery mode, empty trimmed query, and non-positive/non-integer `limit`.
- `searchDiscoverableTools()` throws `Error("Query must contain at least one letter or number.")` if tokenization produces no letter/number tokens; `execute()` catches `Error` and rethrows `ToolError(error.message)`.
- An empty corpus is refused, not answered: `execute()` throws `ToolError("The discoverable-tool inventory is empty …")`. Zero matches on a non-empty corpus return normally and the renderer shows `No matching tools found.`
- `getDiscoverableToolsForDescription()` and `getDiscoverableToolSearchIndexForExecution()` swallow discovery-hook/cache errors and fall back to an empty corpus or rebuilt index.

## Notes
- The tool wire name stays `search_tool_bm25` for persisted-session back-compat, even though the source file is `search-tool-bm25.ts`.
- Corpus composition is session-dependent and excludes already-active tools:
  - MCP entries come from `#discoverableMCPTools` (built by `#collectDiscoverableMCPToolsFromRegistry()`), filtered to names not currently active; `MCPTool` carries no `summary`, so `getDiscoverableTool()` derives `summary` from the first `200` chars of `description`.
  - Built-in entries appear in `"auto"` and `"all"` modes when their registry definition has `loadMode === "discoverable"` and they are not currently active.
  - Eligible first-party heavyweight custom entries such as `generate_image` appear in `"auto"` and `"all"` while inactive. Arbitrary extension and caller-supplied SDK custom tools keep their existing startup behavior.
  - Hidden/internal built-ins are intentionally excluded from the built-in corpus: `resolve`, `yield`, `report_finding`, `report_tool_issue` are called out in the `#collectDiscoverableBuiltinTools()` comment.
- `DiscoverableToolSource` includes `"extension"` and `"custom"`. The session inventory uses `"custom"` for first-party heavyweight tools and does not implicitly hide third-party extension tools.
- On startup, `packages/coding-agent/src/sdk.ts` resolves `"auto"` after the full registry exists. Auto always hides non-essential discoverable built-ins and eligible first-party heavyweight local tools and injects `search_tool_bm25`; above 40 registered tools it also hides MCP tools. `"all"` hides the same local tools plus MCP tools at every tool-set size. Tools whose class is marked as `loadMode === "essential"` (defaults are `read`, `bash`, `launch`, `edit`, `write`, `glob`, and `eval`) are always active; they survive hiding regardless of configuration. `tools.essentialOverride` can be used to treat additional discoverable tools as essential (active on startup) or to explicitly specify the active essential list.
- Query tokenization is simple and deterministic: Unicode is NFKD-normalized, combining marks are dropped, acronym/camelCase and digit-to-capital boundaries are split, non-letter/non-number characters become spaces, tokens are lowercased, and only non-empty tokens survive.
- Scores are rounded differently by surface: `details.tools[].score` keeps 6 decimals; the TUI line renders 3.

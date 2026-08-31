Search hidden tool metadata to discover and activate tools.

Activate hidden tools (MCP and built-in) when you need a capability not in your active tool set.
{{#if hasDiscoverableMCPServers}}
Discoverable MCP servers in this session: {{#list discoverableMCPServerSummaries join=", "}}{{this}}{{/list}}.
{{/if}}
{{#if hasDiscoverableBuiltinTools}}
Discoverable built-in tools: {{#list discoverableBuiltinToolNames join=", "}}{{this}}{{/list}}.
{{/if}}
{{#if discoverableToolCount}}
Total discoverable tools available: {{discoverableToolCount}}.
{{/if}}
Input:
- `query` — required natural-language or keyword query
- `limit` — optional maximum number of matches to return (default `8`)

Behavior:
- Matches against tool name, label, server name, description/summary, and input schema keys
- Activates every match scoring at least half the best match, so a weak match costs nothing
- Repeated searches add to the active tool set; they do not remove earlier selections
- Newly activated tools become available before the next model call in the same overall turn

Notes:
- Start with `limit` 5–10 if unsure.

Not for repository/file/code search. Tool discovery only.

Returns JSON with:
- `query`
- `activated_tools` — tools activated by this search call
- `match_count` — number of ranked matches returned by the search
- `also_matched` — matches returned but not activated; query one by name to activate it
- `total_tools`

<discovery-notice>
{{#if hasMCPDiscoveryServers}}Discoverable MCP servers this session: {{#list mcpDiscoveryServerSummaries join=", "}}{{this}}{{/list}}.{{/if}}
If the task may involve external systems (SaaS APIs, chat, tickets, databases, deployments, or other non-local integrations), you SHOULD call `{{toolRefs.search_tool_bm25}}` before concluding no such tool exists.
</discovery-notice>

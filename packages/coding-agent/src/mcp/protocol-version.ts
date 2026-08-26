/**
 * The MCP protocol revision veyyon declares when it initializes a session. Two modules spoke MCP
 * (`mcp/client.ts`, `web/search/providers/zai.ts`) and each had its own copy; a stale copy negotiates a
 * silent downgrade. One constant keeps them in step.
 */

/** The MCP revision sent as `protocolVersion` in an initialize request. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

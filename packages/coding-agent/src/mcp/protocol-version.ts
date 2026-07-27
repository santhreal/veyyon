/**
 * The MCP protocol revision veyyon declares when it initializes a session.
 *
 * Two modules speak MCP to a server and each declared its own copy: `mcp/client.ts` for every configured MCP
 * server, and `web/search/providers/zai.ts`, which reaches Z.ai's search through an MCP endpoint. The value is
 * sent as `protocolVersion` in the initialize request, so it is one half of a handshake.
 *
 * A server that does not recognise the revision answers with the one it does support rather than failing, so a
 * copy left behind at an older revision negotiates a downgrade instead of erroring: features added since are
 * quietly unavailable, and the reason is not in any message. Keeping the two in step is what makes the two
 * paths behave the same way against the same server.
 */

/** The MCP revision sent as `protocolVersion` in an initialize request. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

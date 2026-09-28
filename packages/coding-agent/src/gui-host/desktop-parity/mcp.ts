/**
 * The `/mcp` subcommands the terminal routes, and the carrier that reaches each
 * from the desktop. Members are the route names `MCPCommandController.handle`
 * declares; `help` is the dispatcher's fallback, not a route.
 */
import type { DesktopCarrier } from "./carrier";

export const MCP_SUBCOMMAND_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	list: { action: "RefreshMcp" },
	enable: { action: "SetMcpEnabled" },
	disable: { action: "SetMcpEnabled" },
	/** `SetMcpEnabled` with `enabled: true` reconnects a connected server and connects a disconnected one. */
	reconnect: { action: "SetMcpEnabled" },
	add: { gap: "A server cannot be added from the desktop; it is added in the terminal or in the config file." },
	remove: { gap: "A server cannot be removed from the desktop." },
	test: { gap: "A server's connection cannot be tested from the desktop without reconnecting it." },
	reauth: { gap: "An MCP server's OAuth login cannot be started again from the desktop." },
	unauth: { gap: "An MCP server's stored OAuth login cannot be deleted from the desktop." },
	resources: { gap: "The resources a connected server offers are not listed on the desktop." },
	prompts: { gap: "The prompts a connected server offers are not listed on the desktop." },
	notifications: { gap: "A server's notification capabilities and subscriptions are not shown on the desktop." },
	"smithery-search": { gap: "The Smithery registry cannot be searched or deployed from on the desktop." },
	"smithery-login": { gap: "A Smithery API key cannot be stored from the desktop." },
	"smithery-logout": { gap: "A stored Smithery API key cannot be deleted from the desktop." },
	reload: {
		gap: "RefreshMcp re-lists the running manager's servers; a forced rediscovery of MCP runtime tools is not offered.",
	},
};

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
	/** A remote server that wants OAuth is added once its login, drawn as `AuthFlow` under `mcp:<name>`, completes. */
	add: { action: "AddMcpServer" },
	remove: { action: "RemoveMcpServer" },
	/** The outcome arrives as `McpProbe`; the running connection is left as it was. */
	test: { action: "TestMcpServer" },
	reauth: { action: "ReauthMcpServer" },
	unauth: { action: "ClearMcpServerAuth" },
	/** `McpCatalog` lists each connected server's resources and resource templates. */
	resources: { section: "McpCatalog" },
	/** `McpCatalog` lists each connected server's prompts with the slash command that runs each. */
	prompts: { section: "McpCatalog" },
	/** `McpCatalog` states the notifications each server declares and the resources the host is subscribed to. */
	notifications: { section: "McpCatalog" },
	/** Results arrive as `McpRegistry`; `DeployMcpRegistryServer` adds one of them. */
	"smithery-search": { action: "SearchMcpRegistry" },
	/** The browser step is drawn as `AuthFlow` under `smithery`; a key sent with `SubmitAuthSecret` is taken instead. */
	"smithery-login": { action: "LoginMcpRegistry" },
	"smithery-logout": { action: "LogoutMcpRegistry" },
	reload: { action: "ReloadMcp" },
};

/**
 * The read-only `/mcp` reports: `list`, `resources`, `prompts` and
 * `notifications`. Each builds transcript text from the MCP manager's state
 * and changes nothing.
 */
import type { SourceMeta } from "../../../discovery/capability/types";
import type { MCPManager } from "../../../mcp";
import { sanitizeMcpStatusError } from "../../../mcp/startup-events";
import type {
	MCPPrompt,
	MCPResource,
	MCPResourceTemplate,
	MCPServerCapabilities,
	MCPServerConfig,
} from "../../../mcp/types";
import { theme } from "../../../theme/theme";
import { shortenPath } from "../../../tools/core/render-utils";
import { groupBySource } from "./command-controller-shared";

interface DiscoveredServer {
	name: string;
	source: SourceMeta;
}

/**
 * The `/mcp list` report: the servers the profile's `mcp.json` at `userPath`
 * declares, the servers `manager` discovered in other tools' configs, and the
 * discovered servers the profile disabled.
 */
export function serverListReport(
	manager: MCPManager | undefined,
	userPath: string,
	userServers: Record<string, MCPServerConfig>,
	disabled: ReadonlySet<string>,
): string {
	const configured = new Set(Object.keys(userServers));
	const discovered = manager ? discoveredServers(manager, configured, disabled) : [];
	if (configured.size === 0 && discovered.length === 0 && disabled.size === 0) {
		return [
			"",
			theme.fg("muted", "No MCP servers configured."),
			"",
			`Use ${theme.fg("accent", "/mcp add")} to add a server.`,
			"",
		].join("\n");
	}

	const lines = ["", theme.bold("Configured MCP Servers"), ""];
	if (configured.size > 0) lines.push(...userServerRows(manager, userPath, userServers));
	if (manager) lines.push(...discoveredServerRows(manager, discovered));
	// Servers disabled via /mcp disable that a third-party config declares.
	lines.push(...disabledServerRows(Array.from(disabled).filter(name => !configured.has(name))));
	return lines.join("\n");
}

/** The `/mcp resources` report: every connected server's resources and resource templates. */
export function resourcesReport(manager: MCPManager): string {
	const sections = manager.getConnectedServers().map(name => resourceRows(name, manager.getServerResources(name)));
	return serverReport("MCP Resources", [], sections, "No resources available on connected servers.");
}

/** The `/mcp prompts` report: every connected server's prompts and their arguments. */
export function promptsReport(manager: MCPManager): string {
	const sections = manager.getConnectedServers().map(name => promptRows(name, manager.getServerPrompts(name)));
	return serverReport("MCP Prompts", [], sections, "No prompts available on connected servers.");
}

/** The `/mcp notifications` report: the notification setting and each connected server's notification support. */
export function notificationsReport(manager: MCPManager): string {
	const { enabled, subscriptions } = manager.getNotificationState();
	const statusIcon = enabled ? theme.fg("success", "enabled") : theme.fg("warning", "disabled");
	const status = [`  Status: ${statusIcon}  ${theme.fg("dim", "(mcp.notifications setting)")}`, ""];
	const sections = manager.getConnectedServers().map(name => {
		const connection = manager.getConnection(name);
		return connection ? notificationRows(name, connection.capabilities, enabled, subscriptions.get(name)) : [];
	});
	return serverReport("MCP Notifications", status, sections, "No servers support notifications.");
}

/**
 * Servers the MCP manager discovered in other tools' configs (.claude.json,
 * .cursor/mcp.json, .vscode/mcp.json, ...) that the profile's `mcp.json`
 * neither declares nor disables.
 */
function discoveredServers(
	manager: MCPManager,
	configured: ReadonlySet<string>,
	disabled: ReadonlySet<string>,
): DiscoveredServer[] {
	const discovered: DiscoveredServer[] = [];
	for (const name of manager.getAllServerNames()) {
		if (configured.has(name) || disabled.has(name)) continue;
		const source = manager.getSource(name);
		if (source) discovered.push({ name, source });
	}
	return discovered;
}

/** The `/mcp list` section for the servers the profile's `mcp.json` declares. */
function userServerRows(
	manager: MCPManager | undefined,
	userPath: string,
	servers: Record<string, MCPServerConfig>,
): string[] {
	const rows = [theme.fg("accent", "User level") + theme.fg("muted", ` (${shortenPath(userPath)}):`)];
	for (const [name, config] of Object.entries(servers)) {
		const state = config.enabled === false ? "inactive" : (manager?.getConnectionStatus(name) ?? "disconnected");
		rows.push(...serverStatusRows(manager, name, state, config.type ?? "stdio"));
	}
	rows.push("");
	return rows;
}

/** The `/mcp list` sections for discovered servers, one per source config file. */
function discoveredServerRows(manager: MCPManager, discovered: readonly DiscoveredServer[]): string[] {
	const rows: string[] = [];
	for (const { providerName, shortPath, items } of groupBySource(discovered, e => e.source)) {
		rows.push(theme.fg("accent", providerName) + theme.fg("muted", ` (${shortPath}):`));
		for (const { name } of items) rows.push(...serverStatusRows(manager, name, manager.getConnectionStatus(name)));
		rows.push("");
	}
	return rows;
}

/**
 * One server's rows in `/mcp list`: the name and status glyph, and, when the
 * server is not connected and the manager retained a failure, an indented dim
 * line with that error. The compact startup banner omits the error; this row
 * shows it.
 */
function serverStatusRows(manager: MCPManager | undefined, name: string, state: string, type?: string): string[] {
	const status =
		state === "inactive"
			? theme.fg("warning", ` ${theme.status.connecting} inactive`)
			: state === "connected"
				? theme.fg("success", ` ${theme.status.active} connected`)
				: state === "connecting"
					? theme.fg("muted", ` ${theme.status.connecting} connecting`)
					: theme.fg("muted", ` ${theme.status.shadowed} not connected`);
	const typeTag = type ? ` ${theme.fg("dim", `[${type}]`)}` : "";
	const rows = [`  ${theme.fg("accent", name)}${status}${typeTag}`];
	if (state === "disconnected" || state === "not connected") {
		const err = manager?.getLastError(name);
		if (err) rows.push(`      ${theme.fg("dim", sanitizeMcpStatusError(err))}`);
	}
	return rows;
}

/** The `/mcp list` section for servers disabled through the profile's disabled-server list. */
function disabledServerRows(names: readonly string[]): string[] {
	if (names.length === 0) return [];
	return [
		theme.fg("accent", "Disabled") + theme.fg("muted", " (discovered servers):"),
		...names.map(
			name => `  ${theme.fg("accent", name)}${theme.fg("warning", ` ${theme.status.connecting} disabled`)}`,
		),
		"",
	];
}

/**
 * A per-server `/mcp` report: `title`, then `preamble`, then every non-empty
 * section, or `empty` when every section is empty.
 */
function serverReport(
	title: string,
	preamble: readonly string[],
	sections: readonly string[][],
	empty: string,
): string {
	const lines = ["", theme.bold(title), "", ...preamble];
	for (const rows of sections) lines.push(...rows);
	if (sections.every(rows => rows.length === 0)) lines.push(theme.fg("muted", empty), "");
	return lines.join("\n");
}

/** One server's `/mcp resources` section; empty when it has no resources or templates. */
function resourceRows(
	name: string,
	data: { resources: readonly MCPResource[]; templates: readonly MCPResourceTemplate[] } | undefined,
): string[] {
	if (!data || (data.resources.length === 0 && data.templates.length === 0)) return [];
	const rows = [`${theme.fg("accent", name)}:`];
	for (const r of data.resources) {
		const desc = r.description ? ` ${theme.fg("dim", r.description)}` : "";
		const mime = r.mimeType ? ` ${theme.fg("dim", `[${r.mimeType}]`)}` : "";
		rows.push(`  ${theme.fg("success", r.uri)}${mime}${desc}`);
	}
	if (data.templates.length > 0) {
		rows.push(`  ${theme.fg("muted", "Templates:")}`);
		for (const t of data.templates) {
			const desc = t.description ? ` ${theme.fg("dim", t.description)}` : "";
			rows.push(`    ${theme.fg("accent", t.uriTemplate)}${desc}`);
		}
	}
	rows.push("");
	return rows;
}

/** One server's `/mcp prompts` section; empty when it has no prompts. */
function promptRows(name: string, prompts: readonly MCPPrompt[] | undefined): string[] {
	if (!prompts?.length) return [];
	const rows = [`${theme.fg("accent", name)}:`];
	for (const p of prompts) {
		const desc = p.description ? ` ${theme.fg("dim", p.description)}` : "";
		rows.push(`  ${theme.fg("success", `/${name}:${p.name}`)}${desc}`);
		if (!p.arguments) continue;
		for (const arg of p.arguments) {
			const required = arg.required ? theme.fg("warning", " *") : "";
			const argDesc = arg.description ? ` - ${arg.description}` : "";
			rows.push(`    ${arg.name}=${required}${theme.fg("dim", argDesc)}`);
		}
	}
	rows.push("");
	return rows;
}

/** One server's `/mcp notifications` section; empty when it supports no notification. */
function notificationRows(
	name: string,
	caps: MCPServerCapabilities,
	enabled: boolean,
	subscribed: ReadonlySet<string> | undefined,
): string[] {
	const supportsSubscribe = caps.resources?.subscribe === true;
	const supportsToolsChanged = caps.tools?.listChanged === true;
	const supportsPromptsChanged = caps.prompts?.listChanged === true;
	const supportsResourcesChanged = caps.resources?.listChanged === true;
	if (!supportsToolsChanged && !supportsPromptsChanged && !supportsResourcesChanged && !supportsSubscribe) return [];
	const check = theme.fg("success", "ok");
	const rows = [`${theme.fg("accent", name)}:`];
	if (supportsToolsChanged) rows.push(`  ${check} tools/list_changed`);
	if (supportsResourcesChanged) rows.push(`  ${check} resources/list_changed`);
	if (supportsPromptsChanged) rows.push(`  ${check} prompts/list_changed`);
	if (supportsSubscribe) rows.push(...subscriptionRows(check, enabled, subscribed));
	else if (caps.resources !== undefined) {
		rows.push(`  ${theme.fg("dim", "x")} resources/subscribe  ${theme.fg("dim", "not supported")}`);
	}
	rows.push("");
	return rows;
}

function subscriptionRows(check: string, enabled: boolean, subscribed: ReadonlySet<string> | undefined): string[] {
	const count = subscribed?.size ?? 0;
	const status =
		enabled && count > 0
			? theme.fg("success", `subscribed (${count} URI${count !== 1 ? "s" : ""})`)
			: enabled
				? theme.fg("muted", "no active subscriptions")
				: theme.fg("dim", "inactive (notifications disabled)");
	const rows = [`  ${check} resources/subscribe  ${status}`];
	if (!enabled || !subscribed) return rows;
	for (const uri of subscribed) rows.push(`    ${theme.fg("success", "ok")} ${theme.fg("dim", uri)}`);
	return rows;
}

import type * as StatsNs from "@veyyon/stats";
import * as openUtils from "../../utils/open";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, removedOptionMessage, usage } from "./parse";

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;

interface StatsDashboardServer {
	port: number;
	stop: () => void;
}

export interface StatsDashboardArgs {
	port: number;
}

export interface StatsDashboardLaunchResult {
	url: string;
	message: string;
}

let activeStatsServer: StatsDashboardServer | undefined;

let statsMod: typeof StatsNs | undefined;

/**
 * Load `@veyyon/stats` (memoized) on the first `/stats`.
 *
 * The barrel pulls the aggregator, the parser, the SQLite layer and the
 * embedded dashboard client — 16 MB of resident heap that a session which never
 * opens the dashboard has no use for. This module itself stays in the eager
 * graph (`builtin-registry` needs the parser and the handler), so the import has
 * to be the lazy edge.
 */
async function loadStats(): Promise<typeof StatsNs> {
	statsMod ??= await import("@veyyon/stats");
	return statsMod;
}

const STATS_DASHBOARD_USAGE = "Usage: /stats [<port>]";

/** The option spellings this grammar no longer has, keyed by bare name. Both used to introduce the port and both now resolve to the same plain word. */
export const STATS_DASHBOARD_REMOVED_OPTIONS: Record<string, string> = {
	port: "write the port as a plain word, as in `/stats 8080`",
	p: "write the port as a plain word, as in `/stats 8080`",
};

/** Parse the argument string of `/stats` into a port. The port is recognized by PATTERN — a run of digits — and here that detection */
export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { port: DEFAULT_STATS_DASHBOARD_PORT };

	const token = tokens[0]!;
	if (token.startsWith("-") || Object.hasOwn(STATS_DASHBOARD_REMOVED_OPTIONS, token.toLowerCase())) {
		// A PLAIN `port` GETS THE SAME REASON AS `--port`. It cannot be a port itself, since a port is digits and these keys are letters, so reading the map here
		return { error: removedOptionMessage(token, STATS_DASHBOARD_REMOVED_OPTIONS, STATS_DASHBOARD_USAGE) };
	}
	if (!/^\d+$/.test(token)) return { error: `Invalid port: ${token}. ${STATS_DASHBOARD_USAGE}` };
	const port = Number(token);
	if (port > 65_535) return { error: `Invalid port: ${token}. ${STATS_DASHBOARD_USAGE}` };
	if (tokens.length > 1) return { error: `Unknown argument: ${tokens[1]}. ${STATS_DASHBOARD_USAGE}` };

	return { port };
}

export async function launchStatsDashboard(args: StatsDashboardArgs): Promise<StatsDashboardLaunchResult> {
	const stats = await loadStats();
	const { processed, files } = await stats.syncAllSessions();
	const total = await stats.getTotalMessageCount();
	let requestedPortIgnored = false;

	if (!activeStatsServer) {
		activeStatsServer = await stats.startServer(args.port);
	} else if (args.port !== activeStatsServer.port) {
		requestedPortIgnored = true;
	}

	const url = `http://localhost:${activeStatsServer.port}`;
	openUtils.openPath(url);

	const serverLine = requestedPortIgnored
		? `Dashboard already running at: ${url} (requested port ${args.port} ignored)`
		: `Dashboard available at: ${url}`;

	return {
		url,
		message: `Synced ${processed} new entries from ${files} files (${total} total)\n${serverLine}`,
	};
}

/** ACP/text-mode `/stats` handler, and the TUI one: this command has no controller because it has nothing to drive — it starts a server and opens a browser, and */
export async function handleStatsAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const parsed = parseStatsDashboardArgs(command.args);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const { message } = await launchStatsDashboard(parsed);
	await runtime.output(message);
	return commandConsumed();
}

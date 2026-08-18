import * as stats from "@veyyon/stats";
import * as openUtils from "../../utils/open";
import { removedOptionMessage } from "./parse";

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

const STATS_DASHBOARD_USAGE = "Usage: /stats [<port>]";

/**
 * The option spellings this grammar no longer has, keyed by bare name. Both used
 * to introduce the port and both now resolve to the same plain word.
 */
const STATS_DASHBOARD_REMOVED_OPTIONS: Record<string, string> = {
	port: "write the port as a plain word, as in `/stats 8080`",
	p: "write the port as a plain word, as in `/stats 8080`",
};

/**
 * Parse the argument string of `/stats` into a port.
 *
 * The port is recognized by PATTERN — a run of digits — and here that detection
 * is provable rather than a guess: `/stats` reads exactly one thing, so there is
 * no second token set an integer could also belong to, and no keyword whose shape
 * an integer could imitate. It follows that a word which is not an integer cannot
 * be anything this command reads, so it is refused with the usage instead of
 * being ignored.
 *
 * Port 0 is accepted and means "let the OS choose", which is why the lower bound
 * is the digit test rather than 1.
 */
export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { port: DEFAULT_STATS_DASHBOARD_PORT };

	const token = tokens[0]!;
	if (token.startsWith("-")) {
		return { error: removedOptionMessage(token, STATS_DASHBOARD_REMOVED_OPTIONS, STATS_DASHBOARD_USAGE) };
	}
	if (!/^\d+$/.test(token)) return { error: `Invalid port: ${token}. ${STATS_DASHBOARD_USAGE}` };
	const port = Number(token);
	if (port > 65_535) return { error: `Invalid port: ${token}. ${STATS_DASHBOARD_USAGE}` };
	if (tokens.length > 1) return { error: `Unknown argument: ${tokens[1]}. ${STATS_DASHBOARD_USAGE}` };

	return { port };
}

export async function launchStatsDashboard(args: StatsDashboardArgs): Promise<StatsDashboardLaunchResult> {
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

export function stopStatsDashboard(): void {
	if (!activeStatsServer) return;
	activeStatsServer.stop();
	activeStatsServer = undefined;
	stats.closeDb();
}

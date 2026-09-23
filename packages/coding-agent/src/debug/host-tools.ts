/**
 * The debug tools, and the ones a host outside the terminal can run.
 *
 * The table is the single list both hosts read: the terminal's selector draws
 * a row per entry, and a host that is not a terminal answers the entries
 * marked `any`. Three of them read or write the terminal itself — the protocol
 * probe, the terminal's own state, and the TUI transcript export — so they are
 * marked `terminal` and no other host offers them.
 *
 * Running one states text and nothing else. A failure throws, so the caller
 * reports it the way it reports any failed request, rather than each host
 * inventing its own error register.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getWorkProfile } from "@veyyon/natives";
import { getSessionsDir } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { formatBytes } from "../tools/core/render-utils";
import { openPath } from "../utils/open";
import { generateHeapSnapshotData, startCpuProfile } from "./profiler";
import { resolveRawSseDebugBuffer } from "./raw-sse-buffer";
import { getRemoteDebugger, startRemoteDebuggerServer } from "./remote-debugger";
import { clearArtifactCache, createDebugLogSource, createReportBundle, getArtifactCacheStats } from "./report-bundle";
import { collectSystemInfo, formatSystemInfo } from "./system-info";

/** Which hosts offer one tool: every host, or the terminal alone. */
export type DebugToolHosts = "any" | "terminal";

export interface DebugToolDeclaration {
	/** The value a selector row carries, and the word a command takes after `/debug`. */
	id: string;
	label: string;
	description: string;
	hosts: DebugToolHosts;
}

/**
 * Every debug tool, in the order a selector lists them.
 *
 * A tool added here reaches the terminal's selector by itself and reaches
 * every other host when it is marked `any`, which is also what decides
 * whether `runDebugTool` answers it.
 */
const TOOLS = [
	{
		id: "open-artifacts",
		label: "Open: artifact folder",
		description: "Open session artifacts in file manager",
		hosts: "any",
	},
	{
		id: "performance",
		label: "Report: performance issue",
		description: "Profile CPU, reproduce, then bundle",
		hosts: "any",
	},
	{ id: "work", label: "Profile: work scheduling", description: "Open flamegraph of last 30s", hosts: "any" },
	{ id: "dump", label: "Report: dump session", description: "Create report bundle immediately", hosts: "any" },
	{ id: "memory", label: "Report: memory issue", description: "Heap snapshot + bundle", hosts: "any" },
	{ id: "logs", label: "View: recent logs", description: "Show last 50 log entries", hosts: "any" },
	{ id: "system", label: "View: system info", description: "Show environment details", hosts: "any" },
	{
		id: "terminal",
		label: "View: terminal state",
		description: "Subprotocols, geometry, scrollback strategy",
		hosts: "terminal",
	},
	{
		id: "protocols",
		label: "Test: terminal protocols",
		description: "Styling, links, text sizing, graphics, notify",
		hosts: "terminal",
	},
	{ id: "raw-sse", label: "View: raw SSE stream", description: "Show live provider SSE frames", hosts: "any" },
	{
		id: "remote-debugger",
		label: "Start: JS remote debugger",
		description: "Expose JavaScriptCore inspector socket (experimental)",
		hosts: "any",
	},
	{
		id: "transcript",
		label: "Export: TUI transcript",
		description: "Write visible TUI conversation to a temp txt",
		hosts: "terminal",
	},
	{ id: "clear-cache", label: "Clear: artifact cache", description: "Remove old session artifacts", hosts: "any" },
] as const satisfies readonly DebugToolDeclaration[];

export const DEBUG_TOOLS: readonly DebugToolDeclaration[] = TOOLS;

/** The tools a host outside the terminal offers, in the order above. */
export const HOST_DEBUG_TOOLS: readonly DebugToolDeclaration[] = TOOLS.filter(tool => tool.hosts === "any");

/**
 * The tools a host outside the terminal answers.
 *
 * The runner table below is keyed by exactly this union, so a tool declared
 * `any` with nothing to run it, and a runner for a tool no host offers, are
 * both type errors rather than a row that lists and then fails.
 */
type HostDebugToolId = Extract<(typeof TOOLS)[number], { hosts: "any" }>["id"];

/** What running a tool needs from the host that asked for it. */
export interface DebugToolContext {
	session: AgentSession;
	sessionManager: SessionManager;
	/**
	 * Put a decision in front of the operator and wait for it.
	 *
	 * Two tools need one: the CPU profile runs until the issue has been
	 * reproduced, and clearing the artifact cache deletes files. `false` is
	 * both the refusal and what an unanswered decision comes back as.
	 */
	confirm(title: string, message: string, affirmative: string): Promise<boolean>;
}

/** How much of a captured SSE stream is stated, newest last. */
const RAW_SSE_TAIL_LINES = 200;

/** The settings a report bundle carries, as the session holds them. */
function reportSettings(session: AgentSession): Record<string, unknown> {
	return {
		model: session.model?.id,
		thinkingLevel: session.thinkingLevel,
		planModeEnabled: session.getPlanModeState()?.enabled ?? false,
	};
}

function rawSseText(session: AgentSession): string | undefined {
	const text = resolveRawSseDebugBuffer(session).toRawText();
	return text.trim().length > 0 ? text : undefined;
}

function bundleStated(kind: string, result: { path: string; files: string[] }): string {
	return `${kind} saved\n${result.path}\nFiles: ${result.files.length}`;
}

async function openArtifacts(ctx: DebugToolContext): Promise<string> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return "The session has no file yet, so it has no artifact folder.";
	const artifactsDir = sessionFile.slice(0, -6);
	const stat = await fs.stat(artifactsDir).catch(() => undefined);
	if (!stat?.isDirectory()) return "The artifact folder does not exist yet.";
	openPath(artifactsDir);
	return `Opened ${artifactsDir}`;
}

async function performanceReport(ctx: DebugToolContext): Promise<string> {
	const profile = await startCpuProfile();
	const reproduced = await ctx.confirm(
		"CPU profiling started",
		"Reproduce the performance issue, then take the profile.",
		"Take the profile",
	);
	const cpuProfile = await profile.stop();
	if (!reproduced) return "CPU profiling stopped without a report.";
	const result = await createReportBundle({
		sessionFile: ctx.sessionManager.getSessionFile(),
		settings: reportSettings(ctx.session),
		rawSseText: rawSseText(ctx.session),
		cpuProfile,
		workProfile: getWorkProfile(30),
	});
	return bundleStated("Performance report", result);
}

async function workProfile(): Promise<string> {
	const profile = getWorkProfile(30);
	if (!profile.svg) return `No work profile data (${profile.sampleCount} samples).`;
	const svgPath = path.join(os.tmpdir(), `work-profile-${Date.now()}.svg`);
	await fs.writeFile(svgPath, profile.svg, "utf8");
	openPath(svgPath);
	return `Opened the flamegraph of the last 30s (${profile.sampleCount} samples)\n${svgPath}`;
}

async function dumpReport(ctx: DebugToolContext): Promise<string> {
	const result = await createReportBundle({
		sessionFile: ctx.sessionManager.getSessionFile(),
		settings: reportSettings(ctx.session),
		rawSseText: rawSseText(ctx.session),
	});
	return bundleStated("Report bundle", result);
}

async function memoryReport(ctx: DebugToolContext): Promise<string> {
	const heapSnapshot = generateHeapSnapshotData();
	const result = await createReportBundle({
		sessionFile: ctx.sessionManager.getSessionFile(),
		settings: reportSettings(ctx.session),
		rawSseText: rawSseText(ctx.session),
		heapSnapshot,
	});
	return bundleStated("Memory report", result);
}

async function recentLogs(): Promise<string> {
	const source = await createDebugLogSource();
	const logs = await source.getInitialText();
	if (logs.trim()) return logs;
	return source.hasOlderLogs() ? "Nothing was logged today; older days are on disk." : "No log entries were found.";
}

async function systemInfo(): Promise<string> {
	return formatSystemInfo(await collectSystemInfo());
}

function rawSse(ctx: DebugToolContext): string {
	const text = rawSseText(ctx.session);
	if (!text) return "No provider frames have been captured in this session.";
	const lines = text.split("\n");
	if (lines.length <= RAW_SSE_TAIL_LINES) return text;
	return [`… ${lines.length - RAW_SSE_TAIL_LINES} earlier lines`, ...lines.slice(-RAW_SSE_TAIL_LINES)].join("\n");
}

async function remoteDebugger(): Promise<string> {
	const running = getRemoteDebugger();
	const info = running ?? (await startRemoteDebuggerServer());
	return [
		`JavaScriptCore remote inspector ${running ? "already running" : "started"}`,
		`Listening on ${info.host}:${info.port}`,
		"Experimental WebKit RemoteInspectorServer socket. One-way for this process — there is no stop.",
	].join("\n");
}

async function clearCache(ctx: DebugToolContext): Promise<string> {
	const sessionsDir = getSessionsDir();
	const stats = await getArtifactCacheStats(sessionsDir);
	if (stats.count === 0) return "The artifact cache is empty.";
	const oldest = stats.oldestDate ? stats.oldestDate.toLocaleDateString() : "unknown";
	const confirmed = await ctx.confirm(
		"Clear artifact cache",
		`${stats.count} artifact files (${formatBytes(stats.totalSize)}), oldest ${oldest}. Remove artifacts older than 30 days?`,
		"Clear",
	);
	if (!confirmed) return "The artifact cache was left as it is.";
	const result = await clearArtifactCache(sessionsDir, 30);
	return `Cleared ${result.removed} artifact directories.`;
}

const RUNNERS: Record<HostDebugToolId, (ctx: DebugToolContext) => Promise<string> | string> = {
	"open-artifacts": openArtifacts,
	performance: performanceReport,
	work: workProfile,
	dump: dumpReport,
	memory: memoryReport,
	logs: recentLogs,
	system: systemInfo,
	"raw-sse": rawSse,
	"remote-debugger": remoteDebugger,
	"clear-cache": clearCache,
};

/** The tool `id` names, or undefined when no tool is spelled that way. */
export function debugTool(id: string): DebugToolDeclaration | undefined {
	return DEBUG_TOOLS.find(tool => tool.id === id);
}

/**
 * Run one tool and state what it did.
 *
 * `id` is a tool marked `any`; a terminal-only tool and an unknown word both
 * throw, because a host that offers neither has nothing to draw for them.
 */
export async function runDebugTool(id: string, ctx: DebugToolContext): Promise<string> {
	const runner = Object.hasOwn(RUNNERS, id) ? RUNNERS[id as HostDebugToolId] : undefined;
	if (!runner) {
		const known = HOST_DEBUG_TOOLS.map(tool => tool.id).join(", ");
		throw new Error(`No debug tool is spelled "${id}". Tools: ${known}`);
	}
	return await runner(ctx);
}

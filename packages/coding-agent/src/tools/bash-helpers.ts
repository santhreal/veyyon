import type { AgentToolResult, ToolApprovalDecision } from "@veyyon/agent-core";
import { type } from "arktype";
import type { BashResult } from "../exec/bash-executor";
import { formatExitCodeNotice } from "../exec/exit-notice";
import type { ClientBridgeTerminalOutput } from "../session/client-bridge";
import type { OutputSummary } from "../session/streaming-output";
import { statementById } from "../system-prompt-builder/statement-registry";
import type { ToolSession } from ".";
import { findCriticalBashRisk, findFlaggedBashPattern, hostReachableCommand } from "./bash-guard";
import type { BashInteractiveResult } from "./bash-interactive";
import { saveOutputArtifact } from "./output-artifact";
import { foldToolOutputBookkeeping } from "./output-fold";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { DEFAULT_TERMINAL_PREVIEW_LINES } from "./render-utils";
import { ToolError } from "./tool-errors";
import { describeTimeoutParam } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

export const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 300_000;
export const DEFAULT_STALL_DETECTION_MS = 30_000;

export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: shellConfig.args.concat([finalLine]) };
}

export { FLAGGED_BASH_PATTERNS } from "./bash-guard";

export function bashJudgementEnv(args: unknown): NodeJS.ProcessEnv {
	const rawEnv = (args as Partial<BashToolInput>).env;
	const merged: NodeJS.ProcessEnv = { ...process.env };
	if (rawEnv && typeof rawEnv === "object") {
		for (const [name, value] of Object.entries(rawEnv as Record<string, unknown>)) {
			if (typeof value === "string") merged[name] = value;
		}
	}
	return merged;
}

export function extractEffectiveBashCommand(rawCommand: string, rawCwd?: string): { command: string; cwd?: string } {
	let command = rawCommand;
	let cwd = rawCwd;
	if (!cwd) {
		const cdMatch = command.match(/^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/);
		if (cdMatch) {
			const target = cdMatch[1].trim().replace(/^["']|["']$/g, "");
			if (target !== "-" && !/[$`(]/.test(cdMatch[1])) {
				cwd = target;
				command = command.slice(cdMatch[0].length);
			}
		}
	}
	return { command, cwd };
}

export function bashApprovalDecision(
	args: unknown,
	extraProtectedPaths: readonly string[] = [],
	sessionCwd = "",
): ToolApprovalDecision {
	const rawCommand = (args as Partial<BashToolInput>).command;
	const initialCommand = typeof rawCommand === "string" ? rawCommand : "";
	const argCwd = (args as Partial<BashToolInput>).cwd;
	const initialCwd = typeof argCwd === "string" ? argCwd : undefined;
	const { command, cwd: effectiveCwd } = extractEffectiveBashCommand(initialCommand, initialCwd);
	let cwd = sessionCwd;
	if (effectiveCwd) {
		try {
			cwd = resolveToCwd(effectiveCwd, sessionCwd);
		} catch {
			cwd = sessionCwd;
		}
	}
	const judgementEnv = bashJudgementEnv(args);
	const risk =
		command === "" ? undefined : findCriticalBashRisk(command, undefined, extraProtectedPaths, judgementEnv, cwd);
	if (risk) {
		return risk.severity === "destroys"
			? { tier: "exec", critical: true, reason: risk.reason }
			: { tier: "exec", override: true, reason: risk.reason };
	}
	const hostText = command === "" ? "" : hostReachableCommand(command, undefined, judgementEnv);
	const flagged = findFlaggedBashPattern(hostText);
	if (flagged) {
		return flagged.severity === "destroys"
			? { tier: "exec", critical: true, reason: flagged.reason }
			: { tier: "exec", override: true, reason: flagged.reason };
	}
	return "exec";
}

export function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	return saveOutputArtifact(session, "bash-original", originalText);
}

export const BASH_TIMEOUT_DESCRIPTION = describeTimeoutParam("bash", { zeroDisablesNoun: "command deadline" });
export const bashCwdStatement = statementById("tool-policy/bash-cwd");
if (!bashCwdStatement) throw new Error("Missing required tool-policy/bash-cwd prompt statement");
export const BASH_CWD_DESCRIPTION = bashCwdStatement.text.trim();

export const bashSchemaBase = type({
	command: type("string").describe("command to execute"),
	"env?": type({ "[string]": "string" }).describe("extra env vars"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": type("string").describe(BASH_CWD_DESCRIPTION),
	"pty?": type("boolean").describe("run in pty mode"),
	"backgroundAfter?": type("number").describe(
		"seconds this command may hold the foreground before it moves to a background job; 0 backgrounds it immediately. Overrides the auto-background setting for this one call, and applies even when that setting is off.",
	),
});

export const bashSchemaWithAsync = type({
	command: "string",
	"env?": { "[string]": "string" },
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": type("string").describe(BASH_CWD_DESCRIPTION),
	"pty?": "boolean",
	"async?": type("boolean").describe("run in background"),
	"backgroundAfter?": type("number").describe(
		"seconds this command may hold the foreground before it moves to a background job; 0 backgrounds it immediately. Overrides the auto-background setting for this one call, and applies even when that setting is off.",
	),
});

export type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;

	async?: boolean;
	pty?: boolean;
	backgroundAfter?: number;
}

export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	exitCode?: number;
	signal?: number;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
		reason?: BackgroundReason;
	};
}

export type BackgroundReason = "threshold" | "stall" | "manual";

export interface BashToolOptions {}

export type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

export interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	getLastOutputAt: () => number;
	stopUpdates: () => void;
}

export function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return foldToolOutputBookkeeping(result.output || "").text;
}

export function isInteractiveResult(result: BashResult | BashInteractiveResult): result is BashInteractiveResult {
	return "timedOut" in result;
}

export function summarizeBridgeOutput<
	T extends { exitCode: number | undefined; cancelled: boolean; timedOut?: boolean },
>(output: ClientBridgeTerminalOutput, rest: T): T & OutputSummary {
	const text = output.output;
	let lineCount = 0;
	if (text.length > 0) {
		lineCount = 1;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 0x0a) lineCount++;
		}
	}
	const lines = lineCount;
	return {
		...rest,
		output: text,
		truncated: output.truncated,
		totalLines: lines,
		totalBytes: Buffer.byteLength(text, "utf-8"),
		outputLines: lines,
		outputBytes: Buffer.byteLength(text, "utf-8"),
	};
}

export function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	let hasOwn = false;
	for (const _ in env) {
		hasOwn = true;
		break;
	}
	if (!hasOwn) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!BASH_ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid bash env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function escapeBashEnvValueForDisplay(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

export function formatBashEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env) return "";
	let hasEnv = false;
	for (const _ in env) {
		hasEnv = true;
		break;
	}
	if (!hasEnv) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

export function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	for (const _ in env) return env;
	return undefined;
}

export function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

function legacyWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

export function formatBackgroundNotice(jobId: string, reason: BackgroundReason = "threshold"): string {
	if (reason === "stall") {
		return (
			`No new output for a while, so this command may be stuck. Backgrounded as job ${jobId}; ` +
			`its result will still be delivered automatically if it finishes. If you believe it is hung, ` +
			`cancel it with the job tool (cancel: ["${jobId}"]).`
		);
	}
	if (reason === "manual") {
		return `Backgrounded as job ${jobId} at the operator's request; result will be delivered automatically.`;
	}
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}

export const SKILL_SCOPE_UNRESOLVED_NOTICE =
	"(skill:// resolved against the process-wide skill set: this session never resolved its own skills, so a skill:// that did not resolve was left as a literal path)";

export function referencesSkillUrl(
	command: string,
	cwd: string | undefined,
	env: Record<string, string> | undefined,
): boolean {
	if (command.includes("skill://")) return true;
	if (cwd?.includes("skill://")) return true;
	if (env) {
		for (const value of Object.values(env)) if (value.includes("skill://")) return true;
	}
	return false;
}

function stripTrailingNotice(text: string, notice: string): string {
	const idx = text.lastIndexOf(notice);
	if (idx === -1) return text;
	let start = idx;
	let end = idx + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

export function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, legacyWallTimeNotice(wallTimeMs));
}

export function stripExitCodeNotice(text: string, exitCode: number | undefined, signal?: number): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode, signal));
}

export function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId, async.reason));
}

export function bashMatcherDigest(args: unknown): string {
	const command = (args as Partial<BashToolInput> | undefined)?.command;
	if (typeof command !== "string") return "";
	return stripHeredocBodies(command);
}

export const HEREDOC_OPENER = /(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

function stripHeredocBodies(command: string): string {
	HEREDOC_OPENER.lastIndex = 0;
	let result = "";
	let copiedTo = 0;
	for (let opener = HEREDOC_OPENER.exec(command); opener; opener = HEREDOC_OPENER.exec(command)) {
		const bodyStart = command.indexOf("\n", HEREDOC_OPENER.lastIndex);
		if (bodyStart === -1) break;
		const marker = opener[3] as string;
		const terminator = new RegExp(`^${opener[1] === "-" ? "\\t*" : ""}${marker}[ \\t]*$`, "m");
		terminator.lastIndex = 0;
		const rest = command.slice(bodyStart + 1);
		const hit = terminator.exec(rest);
		result += command.slice(copiedTo, bodyStart);
		if (!hit) {
			copiedTo = command.length;
			break;
		}
		copiedTo = bodyStart + 1 + hit.index + hit[0].length;
		HEREDOC_OPENER.lastIndex = copiedTo;
	}
	return result + command.slice(copiedTo);
}

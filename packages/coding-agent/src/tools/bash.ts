import * as fs from "node:fs";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { ImageProtocol, TERMINAL } from "@veyyon/tui";
import {
	clampLow,
	errorMessage,
	getProjectDir,
	isEnoent,
	logger,
	prompt,
	SIGNAL_EXIT_BASE,
	signalName,
	signalNumber,
} from "@veyyon/utils";
import { type } from "arktype";
import { type BashResult, executeBash } from "../exec/bash-executor";
import { formatExitCodeNotice } from "../exec/exit-notice";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { paintHotTail, shimmerPhase } from "../modes/components/follow";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { highlightCode } from "../modes/theme/highlight";
import type { Theme } from "../modes/theme/theme-class";
import { expandHintSuffix } from "../modes/utils/key-hint";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ClientBridgeTerminalExitStatus, ClientBridgeTerminalOutput } from "../session/client-bridge";
import { sessionBudgetLimits, sessionCpuLimit } from "../session/cpu-limit";
import {
	artifactFooter,
	DEFAULT_MAX_BYTES,
	enforceInlineByteCap,
	type OutputSummary,
	streamTailUpdates,
	TailBuffer,
} from "../session/streaming-output";
import { statementById } from "../system-prompt-builder/statement-registry";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../tui/output-block";
import { renderStatusLine } from "../tui/status-line";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { registerForegroundBashWait } from "./bash-foreground-registry";
import {
	bashCredentialTargets,
	findCriticalBashRisk,
	findFlaggedBashPattern,
	hostReachableCommand,
} from "./bash-guard";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { resolveEvalBackends } from "./eval-backends";
import { invalidateGithubCacheForBashCommand } from "./gh-cache-invalidation";
import { inlineBudgetFor, inlineOutputPricing, saveOutputArtifact } from "./output-artifact";
import { foldToolOutputBookkeeping } from "./output-fold";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import {
	capPreviewLines,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatToolWorkingDirectory,
	previewWindowRows,
	renderCollapsedOutputLines,
	replaceTabs,
	shortenPath,
} from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 300_000;
const DEFAULT_STALL_DETECTION_MS = 30_000;

export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: shellConfig.args.concat([finalLine]) };
}

export { FLAGGED_BASH_PATTERNS } from "./bash-guard";

function bashJudgementEnv(args: unknown): NodeJS.ProcessEnv {
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

function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	return saveOutputArtifact(session, "bash-original", originalText);
}

const BASH_TIMEOUT_DESCRIPTION = describeTimeoutParam("bash", { zeroDisablesNoun: "command deadline" });
const bashCwdStatement = statementById("tool-policy/bash-cwd");
if (!bashCwdStatement) throw new Error("Missing required tool-policy/bash-cwd prompt statement");
const BASH_CWD_DESCRIPTION = bashCwdStatement.text.trim();

const bashSchemaBase = type({
	command: type("string").describe("command to execute"),
	"env?": type({ "[string]": "string" }).describe("extra env vars"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": type("string").describe(BASH_CWD_DESCRIPTION),
	"pty?": type("boolean").describe("run in pty mode"),
	"backgroundAfter?": type("number").describe(
		"seconds this command may hold the foreground before it moves to a background job; 0 backgrounds it immediately. Overrides the auto-background setting for this one call, and applies even when that setting is off.",
	),
});

const bashSchemaWithAsync = type({
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

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

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

type BackgroundReason = "threshold" | "stall" | "manual";

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	getLastOutputAt: () => number;
	stopUpdates: () => void;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return foldToolOutputBookkeeping(result.output || "").text;
}

function isInteractiveResult(result: BashResult | BashInteractiveResult): result is BashInteractiveResult {
	return "timedOut" in result;
}

function summarizeBridgeOutput<T extends { exitCode: number | undefined; cancelled: boolean; timedOut?: boolean }>(
	output: ClientBridgeTerminalOutput,
	rest: T,
): T & OutputSummary {
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

function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
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

function formatBashEnvAssignments(env: Record<string, string> | undefined): string {
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

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
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

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

function legacyWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

function formatBackgroundNotice(jobId: string, reason: BackgroundReason = "threshold"): string {
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

function referencesSkillUrl(
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

function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, legacyWallTimeNotice(wallTimeMs));
}

function stripExitCodeNotice(text: string, exitCode: number | undefined, signal?: number): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode, signal));
}

function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId, async.reason));
}

export function bashMatcherDigest(args: unknown): string {
	const command = (args as Partial<BashToolInput> | undefined)?.command;
	if (typeof command !== "string") return "";
	return stripHeredocBodies(command);
}

const HEREDOC_OPENER = /(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

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

export class BashTool implements AgentTool<typeof bashSchemaBase | typeof bashSchemaWithAsync, BashToolDetails> {
	readonly name = "bash";
	readonly approval = (args: unknown): ToolApprovalDecision =>
		bashApprovalDecision(args, this.session.settings.get("tools.protectedPaths") ?? [], this.session.cwd);
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly filesystemTargets = (args: unknown): string[] =>
		bashCredentialTargets(String((args as Partial<BashToolInput>).command ?? ""), bashJudgementEnv(args));
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean => this.session.isToolActive?.(name) ?? fallback;
		return prompt.render(toolsPrompts["tools/bash"].text, {
			asyncEnabled: this.#asyncEnabled,
			autoBackgroundEnabled: this.#autoBackgroundEnabled,
			autoBackgroundSeconds: Math.max(0, Math.floor(this.#autoBackgroundThresholdMs / 1000)),
			stallDetectionEnabled: this.#stallDetectionEnabled,
			stallSeconds: Math.max(0, Math.floor(this.#stallMs / 1000)),
			hasGrep: isToolActive("grep", this.session.settings.get("grep.enabled")),
			hasGlob: isToolActive("glob", this.session.settings.get("glob.enabled")),
			hasRead: isToolActive("read", true),
			hasLaunch: isToolActive("launch", this.session.settings.get("launch.enabled")),
			hasEval: isToolActive(
				"eval",
				evalBackends.python || evalBackends.js || evalBackends.ruby || evalBackends.julia,
			),
		});
	}
	readonly parameters: BashToolSchema;
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;
	readonly matcherDigest = (args: unknown): string => bashMatcherDigest(args);
	readonly #asyncEnabled: boolean;
	readonly #autoBackgroundEnabled: boolean;
	readonly #autoBackgroundThresholdMs: number;
	readonly #stallDetectionEnabled: boolean;
	readonly #stallMs: number;

	constructor(private readonly session: ToolSession) {
		this.#asyncEnabled = this.session.settings.get("async.enabled");
		this.#autoBackgroundEnabled = this.session.settings.get("bash.autoBackground.enabled");
		this.#autoBackgroundThresholdMs = Math.max(
			0,
			Math.floor(
				this.session.settings.get("bash.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
			),
		);
		this.#stallDetectionEnabled = this.session.settings.get("bash.stallDetection.enabled");
		this.#stallMs = Math.max(
			0,
			Math.floor(this.session.settings.get("bash.stallDetection.stallMs") ?? DEFAULT_STALL_DETECTION_MS),
		);
		this.parameters = this.#asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		return normalizeResultOutput(result) || "(no output)";
	}

	async #boundBashOutput(text: string, existingArtifactId?: string): Promise<string> {
		const capped = await enforceInlineByteCap(text, {
			...inlineOutputPricing(this.session),
			saveArtifact: existingArtifactId
				? async () => existingArtifactId
				: full => saveBashOriginalArtifact(this.session, full),
		});
		if (existingArtifactId && !capped.includes(`artifact://${existingArtifactId}`)) {
			const sep = capped.length === 0 || capped.endsWith("\n") ? "" : "\n";
			return `${capped}${sep}${artifactFooter(existingArtifactId)}`;
		}
		return capped;
	}

	async #throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): Promise<void> {
		if (result.cancelled) {
			const out = await this.#boundBashOutput(normalizeResultOutput(result), result.artifactId);
			const annotated = isInteractiveResult(result) && out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(annotated || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			const out = await this.#boundBashOutput(normalizeResultOutput(result), result.artifactId);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(out ? `${out}\n\n[${message}]` : message);
		}
		if (result.exitCode === undefined) {
			const out = await this.#boundBashOutput(outputText, result.artifactId);
			throw new ToolError(`${out}\n\nCommand failed: missing exit status`);
		}
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			terminalId?: string;
			wallTimeMs?: number;
		} = {},
	): Promise<AgentToolResult<BashToolDetails>> {
		const exitCode = result.exitCode;
		const signal = "signal" in result ? result.signal : undefined;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const outputLines = [this.#formatResultOutput(result)];
		const notices: string[] = [];
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		if (notices.length > 0) outputLines.push("", ...notices);
		if (failedExit) outputLines.push("", formatExitCodeNotice(exitCode, signal));
		const outputText = outputLines.join("\n");

		await this.#throwIfUnfinished(result, timeoutSec, outputText);

		const details: BashToolDetails = {};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.terminalId !== undefined) {
			details.terminalId = options.terminalId;
		}
		if (options.wallTimeMs !== undefined) {
			details.wallTimeMs = options.wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
			if (signal !== undefined) details.signal = signal;
		}
		const cappedOutputText = await enforceInlineByteCap(outputText, {
			...inlineOutputPricing(this.session),
			saveArtifact: full => saveBashOriginalArtifact(this.session, full),
		});

		const resultBuilder = toolResult(details)
			.text(cappedOutputText)
			.truncationFromSummary(result, { direction: "tail" });
		if (failedExit) resultBuilder.error();
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: { requestedTimeoutSec?: number; notices?: readonly string[]; reason?: BackgroundReason } = {},
	): AgentToolResult<BashToolDetails> {
		const reason: BackgroundReason = options.reason ?? "threshold";
		const details: BashToolDetails = {
			async: { state: "running", jobId, type: "bash", reason },
		};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			for (let ni = 0; ni < options.notices.length; ni++) lines.push(options.notices[ni]!);
			lines.push("");
		}
		lines.push(formatBackgroundNotice(jobId, reason));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];

		resolvedEnv?: Record<string, string>;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		forwardUpdates: boolean;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let lastOutputAt = performance.now();
		let forwardUpdates = options.forwardUpdates;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
				const wallTimeStart = performance.now();
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						env: options.resolvedEnv,
						artifactPath,
						artifactId,
						spillThreshold: inlineBudgetFor(this.session),
						onChunk: chunk => {
							lastOutputAt = performance.now();
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, { async: { state: "running", jobId, type: "bash" } });
						},
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices ?? [],
						wallTimeMs,
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						throw new ToolError(finalText);
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "bash" } });
					return finalText;
				} catch (error) {
					const message = errorMessage(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "bash" } });
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: async text => {
					latestText = text;
					if (!forwardUpdates) return;
					await options.onUpdate?.({
						content: [{ type: "text", text }],
						details: {},
					});
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			getLastOutputAt: () => lastOutputAt,
			stopUpdates: () => {
				forwardUpdates = false;
			},
		};
	}

	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		opts: { thresholdMs: number; stallMs: number; signal?: AbortSignal },
	): Promise<ManagedBashJobCompletion | { kind: "background"; reason: BackgroundReason } | { kind: "aborted" }> {
		const { thresholdMs, stallMs, signal } = opts;
		if (signal?.aborted) {
			return { kind: "aborted" };
		}

		const internal = new AbortController();
		const waiters: Array<
			Promise<ManagedBashJobCompletion | { kind: "background"; reason: BackgroundReason } | { kind: "aborted" }>
		> = [job.completion];
		if (thresholdMs > 0) {
			waiters.push(
				Bun.sleep(thresholdMs).then(() => ({ kind: "background" as const, reason: "threshold" as const })),
			);
		}
		if (stallMs > 0) {
			waiters.push(this.#watchStall(job, stallMs, internal.signal));
		}
		const manual = Promise.withResolvers<{ kind: "background"; reason: BackgroundReason }>();
		const unregisterManual = registerForegroundBashWait(() =>
			manual.resolve({ kind: "background", reason: "manual" }),
		);
		waiters.push(manual.promise);

		let onAbort: (() => void) | undefined;
		if (signal) {
			const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
			onAbort = () => resolveAborted({ kind: "aborted" });
			signal.addEventListener("abort", onAbort, { once: true });
			waiters.push(abortedPromise);
		}

		try {
			return await Promise.race(waiters);
		} finally {
			internal.abort();
			unregisterManual();
			if (signal && onAbort) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	async #watchStall(
		job: ManagedBashJobHandle,
		stallMs: number,
		signal: AbortSignal,
	): Promise<{ kind: "background"; reason: BackgroundReason }> {
		const POLL_CAP_MS = 500;
		while (!signal.aborted) {
			const idleMs = performance.now() - job.getLastOutputAt();
			const remainingMs = stallMs - idleMs;
			if (remainingMs <= 0) {
				return { kind: "background", reason: "stall" };
			}
			await Bun.sleep(Math.min(remainingMs, POLL_CAP_MS));
		}
		return await new Promise<never>(() => {});
	}

	#resolveWaitMs(baseMs: number, timeoutMs: number | undefined): number {
		if (baseMs <= 0) return 0;
		if (timeoutMs === undefined) return baseMs;
		const timeoutBufferMs = 1_000;
		return clampLow(timeoutMs - timeoutBufferMs, 0, baseMs);
	}

	#resolveStallWaitMs(timeoutMs: number | undefined): number {
		return this.#resolveWaitMs(this.#stallMs, timeoutMs);
	}

	async execute(
		_toolCallId: string,
		{
			command: rawCommand,
			env: rawEnv,
			timeout: rawTimeout,
			cwd,

			async: asyncRequested = false,
			pty = false,
			backgroundAfter: rawBackgroundAfter,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const extracted = extractEffectiveBashCommand(rawCommand, cwd);
		let command = extracted.command;
		cwd = extracted.cwd;
		const env = normalizeBashEnv(rawEnv);
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const interception = checkBashInterception(commandToCheck, ctx?.toolNames ?? [], rules);
				if (interception.block) {
					throw new ToolError(interception.message ?? "Command blocked");
				}
			}
		}

		const skillScopeUnresolved = this.session.skills === undefined && referencesSkillUrl(rawCommand, cwd, env);
		if (skillScopeUnresolved) {
			logger.warn("bash: session skills are unresolved, skill:// URLs resolve against the process-wide set", {
				cwd: this.session.cwd,
			});
		}
		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills,
			internalRouter: InternalUrlRouter.instance(),
			cwd: this.session.cwd,
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, { ...internalUrlOptions, ensureLocalParentDirs: true });
		const resolvedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, {
								...internalUrlOptions,
								ensureLocalParentDirs: true,
								noEscape: true,
							}),
						]),
					),
				)
			: undefined;

		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		invalidateGithubCacheForBashCommand(command);

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${shortenPath(commandCwd)}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${shortenPath(commandCwd)}`);
		}

		const requestedTimeoutSec = rawTimeout;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const timeoutSec = timeoutDisabled
			? undefined
			: clampTimeout("bash", requestedTimeoutSec, this.session.settings.get("tools.maxTimeout"));
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		const pendingNotices: string[] = [];
		const cpuLimit = sessionCpuLimit(this.session.getSessionId?.() ?? null);
		if (cpuLimit) {
			await cpuLimit.update(
				this.session.settings.get("session.cpuLimitCores"),
				this.session.settings.get("session.cpuLimitKill"),
				sessionBudgetLimits(this.session.settings),
			);
			await cpuLimit.gateSpawn("a bash command");
		}
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice("bash", requestedTimeoutSec, timeoutSec);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}
		if (skillScopeUnresolved) {
			pendingNotices.push(SKILL_SCOPE_UNRESOLVED_NOTICE);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				forwardUpdates: false,
			});
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty,
		);

		const autoBgManager = this.session.asyncJobManager;
		const requestedBackgroundAfterMs =
			rawBackgroundAfter === undefined ? undefined : Math.max(0, Math.floor(rawBackgroundAfter * 1000));
		const autoBackgroundActive = requestedBackgroundAfterMs !== undefined || this.#autoBackgroundEnabled;
		const configuredThresholdMs = requestedBackgroundAfterMs ?? this.#autoBackgroundThresholdMs;
		if (!pty && !bridgeTerminalAvailable && autoBgManager && !autoBgManager.atCapacity) {
			const wallThresholdMs = autoBackgroundActive ? this.#resolveWaitMs(configuredThresholdMs, timeoutMs) : 0;
			const stallMs = this.#stallDetectionEnabled ? this.#resolveStallWaitMs(timeoutMs) : 0;
			const startBackgrounded = autoBackgroundActive && configuredThresholdMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				forwardUpdates: !startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
					reason: "threshold",
				});
			}
			autoBgManager.acknowledgeDeliveries([job.jobId]);
			const waitResult = await this.#waitForManagedBashJob(job, { thresholdMs: wallThresholdMs, stallMs, signal });
			if (waitResult.kind === "completed") {
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				autoBgManager.resumeDeliveries([job.jobId]);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.stopUpdates();
			autoBgManager.resumeDeliveries([job.jobId]);
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
				reason: waitResult.reason,
			});
		}

		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) {
			const bridgeWallTimeStart = performance.now();
			const shellSpawn = wrapShellLineForClientTerminal(command, this.session.settings.getShellConfig());
			const handle = await clientBridge.createTerminal({
				command: shellSpawn.command,
				args: shellSpawn.args,
				cwd: commandCwd,
				env: resolvedEnv
					? Object.entries(resolvedEnv).map(([name, value]) => ({ name, value: value as string }))
					: undefined,
				outputByteLimit: DEFAULT_MAX_BYTES,
			});

			onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

			const exitPromise = handle.waitForExit();
			let exitStatus!: ClientBridgeTerminalExitStatus;

			type BridgeRaceResult =
				| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
				| { kind: "poll" }
				| { kind: "timeout" }
				| { kind: "aborted" };

			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				killStarted = true;
				return handle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: handle.terminalId, error });
				});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				try {
					if (signal?.aborted) {
						await fireKill();
						throw new ToolAbortError("Command aborted");
					}

					const timeoutPromise = timeoutMs
						? Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const }))
						: undefined;
					for (;;) {
						const racers: Array<Promise<BridgeRaceResult>> = [
							exitPromise.then(s => ({ kind: "exit" as const, status: s })),
							Bun.sleep(250).then(() => ({ kind: "poll" as const })),
						];
						if (timeoutPromise) racers.push(timeoutPromise);
						if (signal) {
							racers.push(abortedP.then(() => ({ kind: "aborted" as const })));
						}
						const raced = await Promise.race(racers);

						if (raced.kind === "aborted" || signal?.aborted) {
							await fireKill();
							throw new ToolAbortError("Command aborted");
						}

						if (raced.kind === "timeout") {
							await fireKill();
							let current = { output: "", truncated: false };
							try {
								current = await handle.currentOutput();
							} catch (error) {
								logger.warn("ACP terminal final output read failed", {
									terminalId: handle.terminalId,
									error,
								});
							}
							const timedOutResult: BashInteractiveResult = summarizeBridgeOutput(current, {
								exitCode: undefined,
								cancelled: false,
								timedOut: true,
							});
							return this.#buildCompletedResult(timedOutResult, timeoutSec, {
								requestedTimeoutSec,
								notices: pendingNotices,
								terminalId: handle.terminalId,
								wallTimeMs: performance.now() - bridgeWallTimeStart,
							});
						}

						if (raced.kind === "exit") {
							exitStatus = raced.status;
							break;
						}

						const pollOutput = await Promise.race([
							handle.currentOutput(),
							abortedP.then(() => undefined as ClientBridgeTerminalOutput | undefined),
						]);
						if (pollOutput === undefined) {
							continue;
						}
						onUpdate?.({
							content: [{ type: "text", text: pollOutput.output }],
							details: { terminalId: handle.terminalId },
						});
					}
				} finally {
					signal?.removeEventListener("abort", onAbortSignal);
				}

				const finalOutput = await handle.currentOutput();

				const rawExitCode = exitStatus.exitCode;
				const bridgeSignal = exitStatus.signal ? signalNumber(exitStatus.signal) : undefined;
				if (exitStatus.signal && bridgeSignal === undefined) {
					throw new Error(
						`Terminal reported termination by signal "${exitStatus.signal}", which is not a signal this platform knows. No exit status can be derived from it.`,
					);
				}
				const exitCode: number | undefined =
					rawExitCode != null
						? rawExitCode
						: bridgeSignal !== undefined
							? SIGNAL_EXIT_BASE + bridgeSignal
							: undefined;

				const bridgeResult: BashResult = {
					...summarizeBridgeOutput(finalOutput, { exitCode, cancelled: false }),
					signal: bridgeSignal,
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					requestedTimeoutSec,
					notices: bridgeNotices,
					terminalId: handle.terminalId,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
				});
			} finally {
				try {
					await handle.release();
				} catch (error) {
					logger.warn("ACP terminal release failed", { terminalId: handle.terminalId, error });
				}
			}
		}

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};

		const interactiveUi = canUseInteractiveBashPty(pty, ctx) ? ctx?.ui : undefined;
		if (pty && !interactiveUi) {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		const cpuBudgetId = cpuLimit && (await cpuLimit.ensureGroup()) ? cpuLimit.budgetName : undefined;
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await runInteractiveBashPty(interactiveUi, {
					command,
					cwd: commandCwd,
					timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					spillThreshold: inlineBudgetFor(this.session),
					...(cpuBudgetId ? { cpuBudgetId } : {}),
				})
			: await executeBash(command, {
					cwd: commandCwd,
					sessionKey: this.session.getSessionId?.() ?? undefined,
					timeout: timeoutMs ?? 0,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					spillThreshold: inlineBudgetFor(this.session),
					onChunk: streamTailUpdates(tailBuffer, onUpdate),
					onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
				});
		const wallTimeMs = performance.now() - wallTimeStart;
		if (("signal" in result ? result.signal : undefined) === 15) {
			const killReport = cpuLimit?.consumeKillReport();
			if (killReport) pendingNotices.push(killReport);
		}
		if (result.cancelled) {
			const out = await this.#boundBashOutput(normalizeResultOutput(result), result.artifactId);
			const message = isInteractiveResult(result) && out ? `${out}\n\n[Command aborted]` : out || "Command aborted";
			if (signal?.aborted) {
				throw new ToolAbortError(message);
			}
			throw new ToolError(message);
		}
		if (isInteractiveResult(result) && result.timedOut) {
			const out = await this.#boundBashOutput(normalizeResultOutput(result), result.artifactId);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(out ? `${out}\n\n[${message}]` : message);
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
		});
	}
}

export interface BashRenderArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	output?: string;
	isFullOutput?: boolean;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}

export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, string> | undefined;
	showHeader?: boolean;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

export function getBashEnvForDisplay(args: BashRenderArgs): Record<string, string> | undefined {
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

export function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	const result = new Array<string>(highlightedLines.length);
	for (let li = 0; li < highlightedLines.length; li++)
		result[li] = li === 0 ? `${prefix}${highlightedLines[li]!}` : highlightedLines[li]!;
	return result;
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	return {
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = formatBashCommandLines(renderArgs, uiTheme);
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const header =
						config.showHeader === false
							? undefined
							: renderStatusLine(
									{
										icon: options.spinnerFrame !== undefined ? "running" : "pending",
										spinnerFrame: options.spinnerFrame,
										title: config.resolveTitle(args, options),
									},
									uiTheme,
								);
					return outputBlock.render(
						{
							header,
							state: options.spinnerFrame !== undefined ? "running" : "pending",
							sections: [{ lines: capPreviewLines(cmdLines, uiTheme, { expanded: options.expanded }) }],
							width,
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
				},
			});
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
			const isError = result.isError === true;
			const isPartial = options.isPartial === true;
			const success = !isPartial && !isError;
			const header =
				config.showHeader === false
					? success || isPartial
						? undefined
						: renderStatusLine({ icon: "error", title: "failed", titleColor: "error" }, uiTheme)
					: renderStatusLine(
							success
								? {
										iconOverride: uiTheme.styledSymbol("tool.bash", "accent"),
										title: config.resolveTitle(args, options),
									}
								: {
										icon: isPartial ? "pending" : "error",
										title: config.resolveTitle(args, options),
									},
							uiTheme,
						);
			const details = result.details;
			const outputBlock = new CachedOutputBlock();

			let cachedWidth: number | undefined;
			let cachedPreviewLines: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedRawOutput: string | undefined;
			let cachedIsPartial: boolean | undefined;
			let cachedLines: readonly string[] | undefined;
			let cachedPreviewWindow: number | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";

					const isPartial = options.isPartial === true;
					const previewWindow = previewWindowRows();

					if (
						cachedLines !== undefined &&
						cachedWidth === width &&
						cachedPreviewLines === previewLines &&
						cachedExpanded === expanded &&
						cachedRawOutput === rawOutput &&
						cachedIsPartial === isPartial &&
						cachedPreviewWindow === previewWindow
					) {
						return cachedLines;
					}
					const withoutBackground = stripBackgroundNotice(rawOutput, details?.async);
					const strippedOutput = stripOutputNotice(withoutBackground, details?.meta);
					const withoutExit = stripExitCodeNotice(strippedOutput, details?.exitCode, details?.signal);
					const withoutWall = stripWallTimeNotice(withoutExit, details?.wallTimeMs);
					const rawOutputArtifact = stripRawOutputArtifactNotice(withoutWall);
					const output = rawOutputArtifact.text;
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					const timeoutDisabled = details?.timeoutDisabled === true || renderContext?.timeout === 0;
					const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? renderContext?.timeout);
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const wallTimeMs = details?.wallTimeMs;
					const statsParts: string[] = [];
					if (details?.async?.state === "running") {
						statsParts.push(`Backgrounded: ${details.async.jobId}`);
					}
					if (wallTimeMs !== undefined) {
						statsParts.push(`Wall: ${formatWallTimeSeconds(wallTimeMs)}s`);
					}
					if (timeoutDisabled) {
						statsParts.push("Timeout: disabled");
					}
					if (typeof timeoutSeconds === "number") {
						statsParts.push(
							requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`,
						);
					}
					if (rawOutputArtifact.artifactId) {
						statsParts.push(`Artifact: ${rawOutputArtifact.artifactId}`);
					}
					if (isError && typeof details?.exitCode === "number") {
						const killedBy =
							details.signal === undefined
								? undefined
								: (signalName(details.signal) ?? `signal ${details.signal}`);
						statsParts.push(killedBy ? `Exit: ${details.exitCode} (${killedBy})` : `Exit: ${details.exitCode}`);
					}
					const timeoutLine =
						statsParts.length > 0
							? uiTheme.fg(
									"dim",
									`${uiTheme.format.bracketLeft}${statsParts.join(" | ")}${uiTheme.format.bracketRight}`,
								)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.truncation && !showingFullOutput) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					const outputLines: string[] = [];
					const hasOutput = displayOutput.trim().length > 0;
					const rawOutputLines = displayOutput.split("\n");
					const sixelLineMask =
						TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(rawOutputLines) : undefined;
					const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
					if (hasOutput) {
						if (hasSixelOutput) {
							for (let oi = 0; oi < rawOutputLines.length; oi++) {
								outputLines.push(
									sixelLineMask?.[oi]
										? rawOutputLines[oi]!
										: uiTheme.fg("toolOutput", replaceTabs(rawOutputLines[oi]!)),
								);
							}
						} else if (expanded) {
							for (let oi = 0; oi < rawOutputLines.length; oi++) {
								outputLines.push(uiTheme.fg("toolOutput", replaceTabs(rawOutputLines[oi]!)));
							}
						} else {
							const textContent = renderCollapsedOutputLines(rawOutputLines, uiTheme).join("\n");
							const previewBudget = Math.min(previewLines, previewWindow);
							const result = truncateToVisualLines(textContent, previewBudget, outputBlockContentWidth(width));
							if (result.skippedCount > 0) {
								outputLines.push(
									uiTheme.fg(
										"dim",
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length})${expandHintSuffix()}`,
									),
								);
							}
							for (let oi = 0; oi < result.visualLines.length; oi++) outputLines.push(result.visualLines[oi]!);
							if (isPartial && outputLines.length > 0) {
								const last = outputLines.length - 1;
								outputLines[last] = paintHotTail(
									outputLines[last]!.trimEnd(),
									uiTheme,
									TERMINAL.trueColor,
									"toolOutput",
									shimmerPhase(performance.now()),
								);
							}
						}
					}
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					const framed = outputBlock.render(
						{
							header,
							state: isPartial ? "pending" : isError ? "error" : "success",
							sections: [
								{
									lines: capPreviewLines(cmdLines ?? [], uiTheme, { expanded }),
								},
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
						},
						uiTheme,
					);

					cachedWidth = width;
					cachedPreviewLines = previewLines;
					cachedExpanded = expanded;
					cachedRawOutput = rawOutput;
					cachedIsPartial = isPartial;
					cachedPreviewWindow = previewWindow;
					cachedLines = framed;
					return framed;
				},
				invalidate: () => {
					outputBlock.invalidate();
					cachedLines = undefined;
					cachedWidth = undefined;
					cachedPreviewLines = undefined;
					cachedExpanded = undefined;
					cachedRawOutput = undefined;
					cachedIsPartial = undefined;
					cachedPreviewWindow = undefined;
				},
			});
		},
		mergeCallAndResult: true,
		inline: true,
	};
}

export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: () => "Bash",
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
	showHeader: false,
});

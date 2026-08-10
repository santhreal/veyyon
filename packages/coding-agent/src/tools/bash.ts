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
// The owner, not the local `../tui` barrel, which re-exports `./file-list` and through it the theme engine.
import { renderStatusLine } from "../tui/status-line";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { registerForegroundBashWait } from "./bash-foreground-registry";
import {
	bashCredentialTargets,
	CRITICAL_BASH_PATTERNS,
	findCriticalBashRisk,
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
} from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 300_000;
const DEFAULT_STALL_DETECTION_MS = 30_000;

/**
 * Shape a shell command line for an ACP-conformant `terminal/create` request.
 *
 * ACP's `command` field is documented as the executable and `args` as its
 * argv tail (see https://agentclientprotocol.com/protocol/v1/terminals), so a
 * spec-conformant client `spawn(command, args)`s them directly — no implicit
 * shell. A raw `bash` tool line ("git status && echo x | head") therefore has
 * to be wrapped in an explicit shell invocation, otherwise the client tries
 * to spawn the whole line as argv[0] and fails with `ENOENT` for anything
 * containing a space, pipe, `&&`, redirect, or `$(...)`.
 *
 * The wrap reuses the same shell binary + args the local `bash-executor` would
 * pick via `settings.getShellConfig()` — Git Bash / `bash.exe` on Windows,
 * `$SHELL` (bash/zsh) with the `sh` fallback on POSIX — so the ACP path
 * preserves `bash` tool semantics (`$VAR`, `$(...)`, `source`, POSIX quoting,
 * `-l`) instead of dropping to `cmd.exe` on Windows. The agent host's shell
 * path is used as a proxy for the client's, matching the near-universal
 * ACP deployment shape of an editor spawning veyyon as a co-hosted subprocess.
 */
export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

export { CRITICAL_BASH_PATTERNS } from "./bash-guard";

/**
 * How the bash tool classifies one call.
 *
 * A named function rather than an inline class field so it can be exercised
 * without constructing a session. `BashTool.approval` is an instance field, so
 * a test reaching for `BashTool.prototype.approval` silently gets `undefined`
 * and measures the default tier instead of the guard: the suite passes while
 * proving nothing, which is the worst kind of green.
 *
 * The decisions are `critical` rather than `override`, because these are the
 * calls that must still stop in yolo, which is the mode every published
 * home-directory wipe happened in.
 */
/**
 * The environment a bash call will actually run with: the process environment
 * with the call's own `env` argument spread over it, which is exactly what
 * `buildNonInteractiveEnv` hands the child.
 *
 * Both judgements that read variables (`findCriticalBashRisk` and
 * `bashCredentialTargets`) go through this. Judging against `process.env`
 * alone let a caller hand the guard one value and the shell another, so
 * `bash({command:"rm -rf $LANG", env:{LANG:"/"}})` was approved and deleted the
 * root. Only string values are taken; anything else is not something the child
 * would receive either.
 */
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

export function bashApprovalDecision(
	args: unknown,
	extraProtectedPaths: readonly string[] = [],
	sessionCwd = "",
): ToolApprovalDecision {
	const rawCommand = (args as Partial<BashToolInput>).command;
	const command = typeof rawCommand === "string" ? rawCommand : "";
	// A relative delete resolves against the directory the command will run in:
	// the call's own `cwd` when it names one, else the session's. Without it
	// `rm -rf ../../../../../..` was judged as "relative, therefore fine" and
	// reached the root from any depth of six or less.
	const argCwd = (args as Partial<BashToolInput>).cwd;
	const cwd = typeof argCwd === "string" && argCwd.startsWith("/") ? argCwd : sessionCwd;
	const judgementEnv = bashJudgementEnv(args);
	const risk =
		command === "" ? undefined : findCriticalBashRisk(command, undefined, extraProtectedPaths, judgementEnv, cwd);
	if (risk) return { tier: "exec", critical: true, reason: risk.reason };
	// The patterns are about TEXT, so they are matched against the part of the
	// line that can reach this host. A `curl … | sh` inside a throwaway container
	// with no volume, privilege, device or host namespace is the container's
	// business; the same pipeline outside one is still critical.
	const hostText = command === "" ? "" : hostReachableCommand(command, undefined, judgementEnv);
	if (hostText !== "" && CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(hostText))) {
		return { tier: "exec", critical: true, reason: "Critical pattern detected" };
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
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/**
	 * The signal that killed the command, when it died from one.
	 *
	 * Present only for a real signalled death, never for a program that exited
	 * with `128 + n` itself. Those two produce the same `exitCode`, and the
	 * difference decides whether a retry can possibly help.
	 */
	signal?: number;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
		/**
		 * Why a still-running call was backgrounded: `threshold` (wall-clock
		 * auto-background), `stall` (no output for the stall window, possibly
		 * stuck), or `manual` (the operator pressed the background key). Drives
		 * the operator notice; absent for non-background states.
		 */
		reason?: BackgroundReason;
	};
}

/** Why a still-running bash call was moved to the background. */
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
	/** `performance.now()` timestamp of the most recent output chunk (job start if none yet). */
	getLastOutputAt: () => number;
	stopUpdates: () => void;
}

/**
 * The output text for a bash result, with runner and build bookkeeping folded out.
 *
 * The fold lives HERE, in the one function every model-facing bash path reads its text
 * through, rather than at each return. It used to sit on the completed-command path only, so
 * a run that was cancelled, timed out, or came back with no exit status carried its
 * bookkeeping into context in full — and a `go test ./...` that had to be killed at the
 * timeout is exactly the kind of result worth folding. A no-op unless the output holds a real
 * run's worth of bookkeeping, and failures are never folded.
 */
function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return foldToolOutputBookkeeping(result.output || "").text;
}

function isInteractiveResult(result: BashResult | BashInteractiveResult): result is BashInteractiveResult {
	return "timedOut" in result;
}

/**
 * Turn an ACP `terminal/output` reply into the size summary the rest of the bash
 * tool reads.
 *
 * TWO THINGS THIS OWNS, both of which were previously written out by hand at
 * each of the bridge's two exits and were wrong in the same way at both.
 *
 * First, byte counts. `text.length` is UTF-16 code units, not bytes, so any
 * non-ASCII output under-reported its own size (a screen of box-drawing
 * characters reported a third of what it actually cost).
 *
 * Second, and this is the one that misleads the agent: the ACP response carries
 * `{output, truncated}` and NO pre-truncation size, so when the client has
 * truncated there is no total to report. Copying the kept length into
 * `totalBytes` made every consumer compute an elision of zero and print
 * "Showing lines 1-N of N" over output that was demonstrably incomplete. The
 * totals are therefore left equal to the kept size deliberately, and
 * `truncationFromSummary` recognises that shape and says the elided amount is
 * unknown rather than deriving a range from it.
 */
function summarizeBridgeOutput<T extends { exitCode: number | undefined; cancelled: boolean; timedOut?: boolean }>(
	output: ClientBridgeTerminalOutput,
	rest: T,
): T & OutputSummary {
	const text = output.output;
	const lines = text.length > 0 ? text.split("\n").length : 0;
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
	if (!env || Object.keys(env).length === 0) return undefined;
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
	if (!env || Object.keys(env).length === 0) return "";
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
	return Object.keys(env).length > 0 ? env : undefined;
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

/**
 * The wall-time line the tool USED to append to its payload. It is no longer
 * emitted (the footer states wall time once, and the string cost every result
 * tokens), but sessions recorded before that still hold it, so the renderer
 * folds this exact line out of a persisted result instead of printing it beside
 * the footer. Reconstructed from the result's own `wallTimeMs`, so it can only
 * match the line we wrote, never a coincidental line of command output.
 */
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

/**
 * Reported when a bash call uses `skill://` but the session never resolved its skill list, so
 * the resolution ran against the process-wide active set rather than this session's scope.
 * Exported for the regression test that locks out the old silent `?? []`.
 */
export const SKILL_SCOPE_UNRESOLVED_NOTICE =
	"(skill:// resolved against the process-wide skill set: this session never resolved its own skills, so a skill:// that did not resolve was left as a literal path)";

/**
 * Whether this bash call actually asks for a `skill://` URL, in the command, the extracted
 * cwd, or any env value. Used to keep the unresolved-skill-scope notice off the 99% of calls
 * that never touch the protocol: a session with genuinely zero skills is legitimate and must
 * stay quiet, only an unresolvable REQUEST is worth reporting.
 */
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

/**
 * Strip the trailing occurrence of `notice` (plus a single surrounding newline
 * on each side) so the TUI can echo the value via a styled footer label
 * instead of repeating it verbatim in the output pane. The notice is
 * reconstructed from the same value the result was tagged with, so a literal
 * sub-string match never strips a coincidental in-output token — only the
 * exact line we appended in #buildCompletedResult.
 */
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
	// Must be given the same signal the notice was formatted with, or the strip
	// silently misses and the notice is shown twice.
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode, signal));
}

function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId, async.reason));
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<typeof bashSchemaBase | typeof bashSchemaWithAsync, BashToolDetails> {
	readonly name = "bash";
	// An arrow rather than the bare function so `this.session` is read at CALL
	// time: the operator's `tools.protectedPaths` additions are settings, and a
	// field initializer cannot be relied on to see the constructor's parameter
	// property. `bashApprovalDecision` stays exported and takes the paths
	// explicitly, so the rule is testable without constructing a session.
	readonly approval = (args: unknown): ToolApprovalDecision =>
		bashApprovalDecision(args, this.session.settings.get("tools.protectedPaths") ?? [], this.session.cwd);
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		return [`Command: ${truncateForPrompt(command)}`];
	};
	// The cwd/secret boundary only sees tools that declare filesystem targets, so
	// without this `bash cat ~/.ssh/id_rsa` ran unasked at every rung where
	// `read` of the same path prompts. Credential paths only; see
	// `bashCredentialTargets` for why this is not the whole command's path set.
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
	// Non-pty calls run alongside each other (the executor isolates overlapping
	// runs on the same shell session); pty takes over the terminal UI and must
	// run alone.
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;
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

	/**
	 * Bound a bash output body through the SAME artifact-spill path the
	 * completed-command path uses ({@link enforceInlineByteCap}). A no-op when the
	 * text already fits the inline budget; otherwise it keeps a head/tail window
	 * and offloads the full text to a `bash-original` artifact with a recoverable
	 * `[raw output: artifact://<id>]` footer. Without this, the abort/timeout/
	 * missing-status error paths returned the full untruncated output (a >50KB
	 * killed command carried the whole buffer for every later turn), while a
	 * completed command of the same size was capped.
	 *
	 * When the executor sink already spilled (`existingArtifactId`), reuse that
	 * handle instead of re-saving a possibly middle-elided body as a second
	 * artifact — the sink's file holds the full pre-truncation stream.
	 */
	async #boundBashOutput(text: string, existingArtifactId?: string): Promise<string> {
		const capped = await enforceInlineByteCap(text, {
			...inlineOutputPricing(this.session),
			saveArtifact: existingArtifactId
				? async () => existingArtifactId
				: full => saveBashOriginalArtifact(this.session, full),
		});
		// enforceInlineByteCap only appends a footer when it itself truncated. If
		// the sink already truncated into the budget (and wrote the full stream
		// to its artifact), still advertise the recoverable handle.
		if (existingArtifactId && !capped.includes(`artifact://${existingArtifactId}`)) {
			const sep = capped.length === 0 || capped.endsWith("\n") ? "" : "\n";
			return `${capped}${sep}${artifactFooter(existingArtifactId)}`;
		}
		return capped;
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user/timeout
	 * aborts and a missing exit status. The foreground and bridge callers plus
	 * the async job manager rely on these throwing so cancellations surface as
	 * aborts and jobs are recorded as failed. A definite non-zero exit is a
	 * completed command that failed; #buildCompletedResult surfaces it as an
	 * error *result* (carrying execution details) rather than a throw.
	 *
	 * Every branch caps the output body first: a killed command can never return
	 * more than the inline budget, matching the completed path.
	 */
	async #throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): Promise<void> {
		if (result.cancelled) {
			// executeBash output already carries a `[Command cancelled]` notice from
			// the sink; PTY/bridge interactive output does not, so annotate it here.
			// The annotation is appended AFTER the cap so it is never elided.
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

		// Aborts / timeouts / missing-status still propagate as thrown errors.
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
		// Final defense at the tool-result boundary: no bash path (client bridge,
		// head-retention spill, minimizer miss) may emit more than
		// ~DEFAULT_MAX_BYTES inline. No-op for already-bounded output.
		const cappedOutputText = await enforceInlineByteCap(outputText, {
			// Scale the inline budget by how long this result will sit in context:
			// an early result is re-read for the rest of the session, a late one
			// barely at all.
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
			lines.push(...options.notices, "");
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
		// Stall detection measures idle time as (now - lastOutputAt). Start the
		// clock at registration so a command that never emits still counts as
		// quiet from the moment it begins.
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
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
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

	/**
	 * Foreground-wait on a managed job until one of: it completes/fails, the
	 * wall-clock threshold elapses (auto-background), the output goes quiet for
	 * the stall window (stall detection), or the caller aborts.
	 *
	 * A `thresholdMs` of `0` disables the wall-clock timer and a `stallMs` of `0`
	 * disables stall detection. Both may be `0`: with neither lever on, this still
	 * races completion against the operator's manual key, which is the whole
	 * reason the key works on a stock install. The `background` result carries the
	 * reason so the operator notice can name it.
	 */
	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		opts: { thresholdMs: number; stallMs: number; signal?: AbortSignal },
	): Promise<ManagedBashJobCompletion | { kind: "background"; reason: BackgroundReason } | { kind: "aborted" }> {
		const { thresholdMs, stallMs, signal } = opts;
		if (signal?.aborted) {
			return { kind: "aborted" };
		}

		// Cancels the stall watcher once the race settles so its poll loop does
		// not spin after a winner is chosen.
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
		// The operator's manual "background this now" key: the TUI resolves this
		// waiter through the foreground-wait registry. Registered for exactly the
		// duration of the race (the finally below), so the composer hint only
		// advertises the key while it can actually win.
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

	/**
	 * Resolve to a `stall` background result once the job has produced no new
	 * output for `stallMs`. Every output chunk pushes `getLastOutputAt()`
	 * forward, resetting the idle window, so a command that keeps printing never
	 * stalls. The poll is capped so the loop exits promptly after `signal`
	 * fires (the race already having a winner).
	 */
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
		// The race is already settled; never resolve so this loser is discarded.
		return await new Promise<never>(() => {});
	}

	/**
	 * The foreground wait for a `baseMs` timer, capped just under the hard
	 * timeout: there is no point backgrounding (or flagging a stall) a second
	 * before the command would time out anyway. `baseMs <= 0` disables the
	 * timer (returns `0`). Shared by the auto-background and stall timers so the
	 * clamp lives in ONE place.
	 */
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
		let command = rawCommand;
		const env = normalizeBashEnv(rawEnv);

		// Extract leading `cd <path> && ...` into cwd when the model ignores the cwd parameter.
		// Constrained to a single line so a `&&` that sits on a later line of a multiline
		// script can't pull the entire script into the "cwd" capture.
		if (!cwd) {
			const cdMatch = command.match(/^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/);
			// Skip extraction when the path needs shell expansion ($VAR, $(...),
			// backticks) — resolveToCwd only expands `~`, so routing those through
			// cwd would reject commands the shell itself handles fine.
			if (cdMatch && !/[$`(]/.test(cdMatch[1])) {
				cwd = cdMatch[1].trim().replace(/^["']|["']$/g, "");
				command = command.slice(cdMatch[0].length);
			}
		}
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		// Check both the original command and the cwd-normalized command so
		// leading `cd ... &&` wrappers do not hide either shell-navigation rules
		// or the dedicated-tool command that follows the directory change.
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

		// `skills: this.session.skills ?? []` used to sit here, and the `?? []` is a lie about
		// scope: `[]` asserts this session HAS no skills, which `skill-protocol.ts` honors
		// (`context?.skills ?? getActiveSkills()`). So an unresolved parent suppressed the
		// process-wide snapshot, every `skill://` resolved to "Unknown skill: X / Available:
		// none", and `expandInternalUrls` swallowed that and left the URL as a literal path,
		// which bash then reported as a missing file. Pass the absence through, and when the
		// command actually asked for a `skill://`, name the gap in the notices this tool
		// already returns instead of letting the model debug a phantom path.
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

		// Resolve protocol URLs (skill://, agent://, etc.) in extracted cwd.
		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		// Best-effort cache invalidation: drop github-cache rows for any issue/PR
		// number touched by a mutating `gh` subcommand inside this bash call so
		// subsequent issue:// / pr:// reads pick up the post-mutation state
		// instead of the cached pre-mutation snapshot.
		invalidateGithubCacheForBashCommand(command);

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		// A timeout of 0 is an explicit long-running-command contract: the user
		// must still cancel the call or job, but veyyon does not impose a deadline.
		const requestedTimeoutSec = rawTimeout;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const timeoutSec = timeoutDisabled
			? undefined
			: clampTimeout("bash", requestedTimeoutSec, this.session.settings.get("tools.maxTimeout"));
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		const pendingNotices: string[] = [];
		// The session tree's budget group: pick up live settings for every limit,
		// then refuse while any of them says so (CPU saturated, write budget
		// spent, process cap reached, or a memory cap that cannot be enforced
		// here). Every spawn path below (PTY, executor, bridge) is gated by this
		// one check.
		const cpuLimit = sessionCpuLimit(this.session.getSessionId?.() ?? null);
		if (cpuLimit) {
			await cpuLimit.update(
				this.session.settings.get("session.cpuLimitCores"),
				this.session.settings.get("session.cpuLimitKill"),
				sessionBudgetLimits(this.session.settings),
			);
			cpuLimit.assertMaySpawn("a bash command");
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

		// The client-bridge terminal provides a live terminal card in the editor;
		// when available it wins over auto-backgrounding (both are opt-in, and
		// auto-background would otherwise silently disable the terminal route).
		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty,
		);

		const autoBgManager = this.session.asyncJobManager;
		// A per-call `backgroundAfter` is the model's own deadline. It overrides the
		// configured threshold and arms the wall-clock timer even when the setting
		// is off, because asking for it IS the opt-in.
		const requestedBackgroundAfterMs =
			rawBackgroundAfter === undefined ? undefined : Math.max(0, Math.floor(rawBackgroundAfter * 1000));
		const autoBackgroundActive = requestedBackgroundAfterMs !== undefined || this.#autoBackgroundEnabled;
		const configuredThresholdMs = requestedBackgroundAfterMs ?? this.#autoBackgroundThresholdMs;
		// EVERY non-PTY, non-bridge call routes through the managed-job machinery,
		// not only one with a timer armed. That registration is what gives the
		// operator's manual background key something to win: the foreground wait
		// publishes a resolver for its duration, and that same registration raises
		// the `ctrl+b background` chip. Gating this on the two auto levers meant
		// that with both off, which was the default, the key was dead and the chip
		// never appeared, so a documented shortcut did nothing on a stock install.
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every bash call until a slot frees up.
		if (!pty && !bridgeTerminalAvailable && autoBgManager && !autoBgManager.atCapacity) {
			// Wall-clock timer only when auto-background is on, stall timer only
			// when stall detection is on. With neither, the race still runs so the
			// manual key and the completion path stay live, just without a timer.
			const wallThresholdMs = autoBackgroundActive ? this.#resolveWaitMs(configuredThresholdMs, timeoutMs) : 0;
			const stallMs = this.#stallDetectionEnabled ? this.#resolveStallWaitMs(timeoutMs) : 0;
			// "Immediately" is a CONFIGURED zero, never a clamped one. `#resolveWaitMs`
			// collapses the timer to 0 when the command's own timeout would fire
			// first, and reading that as "background now" would shunt every
			// short-timeout command straight to a background job the moment
			// auto-background became the default.
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
			// Suppress the completion delivery up front so a job finishing while we
			// foreground-wait cannot also be injected by the delivery loop. Lifted
			// via resumeDeliveries() if we end up backgrounding after all.
			autoBgManager.acknowledgeDeliveries([job.jobId]);
			const waitResult = await this.#waitForManagedBashJob(job, { thresholdMs: wallThresholdMs, stallMs, signal });
			if (waitResult.kind === "completed") {
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
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

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI).
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

			// Emit partial update so the editor can embed the live terminal card.
			onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

			const exitPromise = handle.waitForExit();
			let exitStatus!: ClientBridgeTerminalExitStatus;

			type BridgeRaceResult =
				| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
				| { kind: "poll" }
				| { kind: "timeout" }
				| { kind: "aborted" };

			// Set up abort listener before entering the poll loop. The listener
			// kicks off `handle.kill()` synchronously so a `session/cancel`
			// arriving mid-poll terminates the remote command immediately,
			// instead of waiting for the next `currentOutput()` to return.
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
					// Poll until the process exits, times out, or the caller aborts.
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
							// Kill before reading final output so a slow `terminal/output`
							// RPC cannot let a timed-out command keep running past the
							// enforced timeout. The handle stays valid post-kill so the
							// buffered output is still readable.
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

						// Poll tick: push current output so agent-loop transcript stays consistent.
						// Race the read against abort so a stuck `terminal/output` RPC does not
						// delay cancellation.
						const pollOutput = await Promise.race([
							handle.currentOutput(),
							abortedP.then(() => undefined as ClientBridgeTerminalOutput | undefined),
						]);
						if (pollOutput === undefined) {
							// Abort fired during the poll-tick read; let the next loop iteration
							// observe `signal?.aborted` and exit via the abort branch.
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

				// Fetch final output; the terminal is released in the outer finally.
				const finalOutput = await handle.currentOutput();

				// Map exit status. A null exitCode with a signal is a signalled death, so
				// report the shell's 128+N for that specific signal and carry the raw
				// number alongside it. This used to hardcode 137 for every signal, which
				// reported an ordinary SIGTERM (143) as a SIGKILL.
				const rawExitCode = exitStatus.exitCode;
				const bridgeSignal = exitStatus.signal ? signalNumber(exitStatus.signal) : undefined;
				if (exitStatus.signal && bridgeSignal === undefined) {
					// Guessing a number here would put a fabricated exit code in front of the
					// agent. Refuse instead: an unresolvable status is a missing status, and
					// the caller already treats that as an error rather than as success.
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

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		// Allocate artifact for truncated output storage
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
		// A SIGTERM'd command might be the CPU budget's kill, not a crash: when
		// the watcher fired one, say so on the result.
		if (("signal" in result ? result.signal : undefined) === 15) {
			const killReport = cpuLimit?.consumeKillReport();
			if (killReport) pendingNotices.push(killReport);
		}
		if (result.cancelled) {
			// PTY output carries no cancel/timeout notice of its own; annotate so
			// the model can tell an abort from a plain failure. Cap first so a
			// killed command's output cannot exceed the inline budget.
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

// =============================================================================
// TUI Renderer
// =============================================================================
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
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
	// The parsed args don't always mirror the exact current stream prefix, so recover
	// env from the raw JSON buffer to surface `NAME="..." cmd` in the preview as it
	// streams rather than only once the args object finishes.
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

/**
 * Returns the bash command formatted for the result body: the dim `$ cd … &&`
 * prefix joined with syntax-highlighted command lines. The prefix is applied
 * only to the first line so multi-line commands display cleanly — terminals
 * reset SGR state at line boundaries, which made the previous single-string
 * `theme.fg("dim", ...)` form render only the first line as dim.
 */
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
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
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
					? // `showHeader: false` suppresses a title that would only repeat what the
						// `$ command` line already says. It used to suppress the FAILURE too: the
						// block's border tint was then the one and only signal that a command
						// failed, so with colour stripped — a monochrome terminal, a colour-blind
						// reader, a copied transcript — a failing run was byte-identical to a
						// clean one. A failed run gets a header of its own, glyph included, and
						// still no redundant title.
						success || isPartial
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

			// Per-instance cache for the expensive inner lines computation. Mirrors
			// the eval-renderer pattern (`eval-render.ts:709-752`): without this,
			// every TUI repaint (one per keystroke when a long transcript is on
			// screen) re-runs `split` / `replaceTabs` / `truncateToVisualLines` over
			// the whole stored output for every bash row in scrollback. With a
			// 50KB-tail bash result times hundreds of rows, that re-rendering is
			// what pinned the main thread in issue #2081 and made keystrokes feel
			// like the CPU was at 100%. The cache key includes every render input
			// that materially affects the produced lines.
			let cachedWidth: number | undefined;
			let cachedPreviewLines: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedRawOutput: string | undefined;
			let cachedIsPartial: boolean | undefined;
			let cachedLines: readonly string[] | undefined;
			let cachedPreviewWindow: number | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					// REACTIVE: read mutable options at render time
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					// Get output from context (preferred) or fall back to result content.
					// Strip the LLM-facing notice appended by wrappedExecute so we don't
					// double-print it alongside the styled warning line below.
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

					// Build truncation warning
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
						// Name the signal in the stats line too, so the difference is visible
						// at a glance and not only in the notice appended to the output.
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
							outputLines.push(
								...rawOutputLines.map((line, index) =>
									sixelLineMask?.[index] ? line : uiTheme.fg("toolOutput", replaceTabs(line)),
								),
							);
						} else if (expanded) {
							outputLines.push(...rawOutputLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						} else {
							// Progress runs collapse BEFORE the tail window is measured, so a
							// build's `Compiling …` wall cannot spend the whole window and push
							// the one interesting line out of it. `expanded` (ctrl+o) above and
							// the raw artifact still carry every line.
							const textContent = renderCollapsedOutputLines(rawOutputLines, uiTheme).join("\n");
							// Cap the collapsed/streaming output to a viewport-sized tail and
							// measure it at the box's INNER width. Otherwise a growing tail
							// window scrolls its (mutating) rows above the live-region window
							// and the engine re-commits a fresh snapshot every frame —
							// spraying duplicate "… ctrl+o to expand" banners into native
							// scrollback (the box never overflows the viewport now).
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
							outputLines.push(...result.visualLines);
							// The follow, on tools: while output is still streaming, the
							// newest visible line carries the hot trail (cooling into
							// toolOutput). Deterministic per content, so the render cache
							// above stays valid; sealed results never paint it.
							if (isPartial && outputLines.length > 0) {
								const last = outputLines.length - 1;
								// Trim the visual-line padding first: the trail grades the
								// newest CHARACTERS, and foreground color on trailing pad
								// spaces is invisible (the live-frame defect this fixes).
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
									// Viewport-sized tail window in every state — streaming and final
									// render identically; only ctrl+o uncaps.
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

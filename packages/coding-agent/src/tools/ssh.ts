import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import type { Component } from "@veyyon/tui";
import type { SSHHost } from "../capability/ssh";
import { formatExitCodeNotice } from "../exec/exit-notice";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import type { Theme } from "../modes/theme/theme";
import { expandHintSuffix } from "../modes/utils/key-hint";
import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { ensureHostInfo } from "../ssh/connection-manager";
import { executeSSH } from "../ssh/ssh-executor";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { inlineBudgetFor } from "./output-artifact";
import { formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import { capPreviewLines, PREVIEW_LIMITS, replaceTabs } from "./render-utils";
import type { SSHToolDetails, SshToolParams } from "./ssh-helpers";
import { assertValidSshCwd, buildRemoteCommand, formatDescription, loadHosts, sshSchema } from "./ssh-helpers";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, formatTimeoutClampNotice } from "./tool-timeouts";

export class SshTool implements AgentTool<typeof sshSchema, SSHToolDetails> {
	readonly name = "ssh";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<SshToolParams>;
		const host = typeof params.host === "string" ? params.host : "(missing)";
		const command = typeof params.command === "string" ? params.command : "(missing)";
		return [`Host: ${truncateForPrompt(host)}`, `Command: ${truncateForPrompt(command)}`];
	};
	readonly summary = "Execute a command on a remote host over SSH";
	readonly loadMode = "discoverable";
	readonly label = "SSH";
	readonly parameters = sshSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly examples: readonly ToolExample<SshToolParams>[] = [
		{
			caption: "List files: Linux (on server1 (10.0.0.1) | linux/bash)",
			call: { host: "server1", command: "ls -la /home/user" },
		},
		{
			caption: "Show running processes: Windows cmd (on winbox (192.168.1.5) | windows/cmd)",
			call: { host: "winbox", command: "tasklist /v" },
		},
		{
			caption: "Get system info: macOS (on macbook (10.0.0.20) | macos/zsh)",
			call: { host: "macbook", command: "uname -a && sw_vers" },
		},
	];

	readonly #allowedHosts: Set<string>;

	constructor(
		private readonly session: ToolSession,
		private readonly hostNames: string[],
		private readonly hostsByName: Map<string, SSHHost>,
		readonly description: string,
	) {
		this.#allowedHosts = new Set(this.hostNames);
	}

	async execute(
		_toolCallId: string,
		{ host, command, cwd, timeout: rawTimeout }: SshToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SSHToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<SSHToolDetails>> {
		if (!this.#allowedHosts.has(host)) {
			throw new ToolError(`Unknown SSH host: ${host}. Available hosts: ${this.hostNames.join(", ")}`);
		}

		const hostConfig = this.hostsByName.get(host);
		if (!hostConfig) {
			throw new ToolError(`SSH host not loaded: ${host}`);
		}
		assertValidSshCwd(cwd);

		const hostInfo = await ensureHostInfo(hostConfig);
		const remoteCommand = buildRemoteCommand(command, cwd, hostInfo);

		const timeoutSec = clampTimeout("ssh", rawTimeout, this.session.settings.get("tools.maxTimeout"));
		const timeoutMs = timeoutSec * 1000;
		const clampNotice = formatTimeoutClampNotice("ssh", rawTimeout, timeoutSec);

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("ssh")) ?? {};

		const result = await executeSSH(hostConfig, remoteCommand, {
			timeout: timeoutMs,
			signal,
			compatEnabled: hostInfo.compatEnabled,
			artifactPath,
			artifactId,
			spillThreshold: inlineBudgetFor(this.session),
			onChunk: streamTailUpdates(tailBuffer, onUpdate),
		});

		if (result.cancelled) {
			throw new ToolError(result.output || "Command aborted");
		}

		const commandOutput = result.output || "(no output)";
		const outputText = clampNotice ? `${clampNotice}\n\n${commandOutput}` : commandOutput;
		const details: SSHToolDetails = {};
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });

		if (result.exitCode !== 0 && result.exitCode !== undefined) {
			throw new ToolError(`${outputText}\n\n${formatExitCodeNotice(result.exitCode)}`);
		}

		return resultBuilder.done();
	}
}

export async function loadSshTool(session: ToolSession): Promise<SshTool | null> {
	const { hostNames, hostsByName } = await loadHosts(session);
	if (hostNames.length === 0) {
		return null;
	}

	const descriptionHosts = hostNames
		.map(name => hostsByName.get(name))
		.filter((host): host is SSHHost => host !== undefined);
	const description = formatDescription(descriptionHosts);

	return new SshTool(session, hostNames, hostsByName, description);
}

interface SshRenderArgs {
	host?: string;
	command?: string;
	timeout?: number;
}

function hasStreamedRenderArgs(args: unknown): boolean {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return false;
	return typeof args.__partialJson === "string";
}

interface SshRenderContext {
	visualLines?: string[];
	skippedCount?: number;
	totalVisualLines?: number;
}

function formatSshCommandLines(command: string, uiTheme: Theme): string[] {
	const sanitized = replaceTabs(command);
	const rawLines = sanitized.length > 0 ? sanitized.split("\n") : ["…"];
	const prefix = uiTheme.fg("dim", "$ ");
	const result: string[] = new Array(rawLines.length);
	for (let li = 0; li < rawLines.length; li++) {
		result[li] = li === 0 ? `${prefix}${rawLines[li]!}` : rawLines[li]!;
	}
	return result;
}

export const sshToolRenderer = {
	animatedPendingPreview: true,
	renderCall(args: SshRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const host = args.host || "…";
		const command = args.command ?? "";
		const cmdLines = formatSshCommandLines(command, uiTheme);
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const header = renderStatusLine(
					{
						icon: options.spinnerFrame !== undefined ? "running" : "pending",
						spinnerFrame: options.spinnerFrame,
						title: "SSH",
						description: `[${host}]`,
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
			details?: SSHToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions & { renderContext?: SshRenderContext },
		uiTheme: Theme,
		args?: SshRenderArgs,
	): Component {
		const details = result.details;
		const host = args?.host || "…";
		const command = args?.command ?? "";
		const isError = result.isError === true;
		const isPartial = options.isPartial === true;
		const header = renderStatusLine(
			isPartial
				? { icon: "pending", title: "SSH", description: `[${host}]` }
				: isError
					? { icon: "error", title: "SSH", description: `[${host}]` }
					: { iconOverride: uiTheme.styledSymbol("tool.ssh", "accent"), title: "SSH", description: `[${host}]` },
			uiTheme,
		);
		const cmdLines = formatSshCommandLines(command, uiTheme);
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		const outputBlock = new CachedOutputBlock();

		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const { expanded } = options;
				const output = stripOutputNotice(textContent, details?.meta).trimEnd();
				const outputLines: string[] = [];

				if (output) {
					if (expanded) {
						for (let si = 0, start = 0; si <= output.length; si++) {
							if (si === output.length || output.charCodeAt(si) === 0x0a) {
								outputLines.push(uiTheme.fg("toolOutput", output.slice(start, si)));
								start = si + 1;
							}
						}
					} else {
						const sanitized = output.split("\n").map(replaceTabs).join("\n");
						const result = truncateToVisualLines(
							sanitized,
							PREVIEW_LIMITS.OUTPUT_COLLAPSED,
							outputBlockContentWidth(width),
						);
						if (result.skippedCount > 0) {
							outputLines.push(
								uiTheme.fg(
									"dim",
									`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length})${expandHintSuffix()}`,
								),
							);
						}
						outputLines.push(...result.visualLines.map(line => uiTheme.fg("toolOutput", line)));
					}
				}

				if (details?.meta?.truncation) {
					const warning = formatStyledTruncationWarning(details.meta, uiTheme);
					if (warning) outputLines.push(warning);
				}

				return outputBlock.render(
					{
						header,
						state: isPartial ? "pending" : isError ? "error" : "success",
						sections: [
							{
								lines: capPreviewLines(cmdLines, uiTheme, { expanded }),
							},
							{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
						],
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
	mergeCallAndResult: true,
	forceFirstResultViewportRepaint: hasStreamedRenderArgs,
	forceResultViewportRepaintOnSettle: true,
};

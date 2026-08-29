import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage, prompt } from "@veyyon/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import { framedBlock, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";
import { SET_CWD_TOOL_NAME } from "./reroot-hint";
import type { SetCwdToolDetails, SetCwdToolInput } from "./set-cwd-helpers";

import { describeRuleChange, setCwdFilesystemTargets, setCwdSchema } from "./set-cwd-helpers";
import { ToolError, toolFailure } from "./tool-errors";

export type { SetCwdToolDetails };
export { setCwdFilesystemTargets };

export class SetCwdTool implements AgentTool<typeof setCwdSchema, SetCwdToolDetails> {
	readonly name = SET_CWD_TOOL_NAME;
	readonly label = "SetCwd";
	readonly description: string;
	readonly parameters = setCwdSchema;
	readonly strict = true;
	readonly approval = "write" as const;
	readonly loadMode = "discoverable";
	readonly summary = "Change the session's working directory for the rest of the session";
	readonly filesystemTargets = (args: unknown): string[] => setCwdFilesystemTargets(args);
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(toolsPrompts["tools/set-cwd"].text, {
			argot: session.settings.get("argot.enabled") === true,
		});
	}

	formatApprovalDetails = (args: unknown): string[] => {
		const raw = (args as Partial<SetCwdToolInput>)?.path;
		const requested = typeof raw === "string" ? raw.trim() : "";
		const previous = path.resolve(this.#session.cwd);
		const next = requested ? resolveToCwd(requested, previous) : "(missing path)";
		return [`Working directory: ${previous} → ${next}`];
	};

	async execute(
		_toolCallId: string,
		params: SetCwdToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SetCwdToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SetCwdToolDetails>> {
		const raw = typeof params.path === "string" ? params.path.trim() : "";
		if (!raw) {
			throw new ToolError("path is required");
		}
		if (!this.#session.setCwd) {
			throw new ToolError("Session does not support setCwd.");
		}

		const previous = path.resolve(this.#session.cwd);
		const resolved = resolveToCwd(raw, previous);
		let cwd: string;
		try {
			cwd = await this.#session.setCwd(resolved, { validate: true });
		} catch (err) {
			throw toolFailure(err);
		}

		const noop = cwd === previous;
		const lines = noop
			? [
					`Cwd stays at ${cwd}. Your requested path ${JSON.stringify(raw)} resolved to the directory the session was already in, so nothing moved. This call succeeded; do not retry it. Relative paths resolve from there, so read "." to list the top level of your cwd.`,
				]
			: [
					`Moved cwd: ${previous} → ${cwd}. Your requested path ${JSON.stringify(raw)} resolved to ${cwd}. Relative paths now resolve from there, so read "." to list the top level of your new cwd. This change is session-scoped and ephemeral; a per-profile default working directory is the session.workdir setting, not this tool.`,
				];
		lines.push(
			`Path display note: "." in later tool paths and directory headers means the current cwd, ${cwd}; it does not mean the parent directory (that is ".."). Treat ${cwd} as authoritative and do not run another tool to rediscover it.`,
		);
		const details: SetCwdToolDetails = { previous, cwd, requested: raw };
		try {
			const change = await describeRuleChange(previous, cwd);
			lines.push("", ...change.lines);
			details.rulesApplied = change.applied;
			details.rulesDropped = change.dropped;
			details.rulesUnchanged = change.unchanged;
		} catch (err) {
			lines.push(
				"",
				noop
					? `WARNING: the cwd is unchanged, but the rule files for ${cwd} could not be read (${errorMessage(err)}), so which instructions are in effect is unknown. Read AGENTS.md and CLAUDE.md under ${cwd} before continuing.`
					: `WARNING: the cwd changed, but the rule files for the new directory could not be read (${errorMessage(err)}). Your instructions may still be the previous directory's. Read AGENTS.md and CLAUDE.md under ${cwd} before continuing.`,
			);
		}

		return { content: [{ type: "text", text: lines.join("\n") }], details };
	}
}

export const setCwdToolRenderer = {
	name: SET_CWD_TOOL_NAME,
	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		const label = typeof pathArg === "string" ? truncateToWidth(shortenPath(pathArg), TRUNCATE_LENGTHS.TITLE) : "…";
		return new Text(theme.fg("toolTitle", `set_cwd ${label}`));
	},
	renderArguments(args: unknown): string {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		return typeof pathArg === "string" ? pathArg : "";
	},
	renderResult(
		result: AgentToolResult<SetCwdToolDetails>,
		_options: RenderResultOptions,
		theme: Theme,
	): Component | undefined {
		const details = result.details;
		const line = !details
			? "cwd"
			: details.previous !== details.cwd
				? `${details.previous} → ${details.cwd}`
				: `${details.cwd} (already here)`;
		const applied = details?.rulesApplied?.length ?? 0;
		const dropped = details?.rulesDropped?.length ?? 0;
		const meta = [line];
		if (applied > 0 || dropped > 0) {
			const counts = [applied > 0 ? `+${applied}` : "", dropped > 0 ? `-${dropped}` : ""].filter(Boolean).join(" ");
			meta.push(`${counts} ${applied + dropped === 1 ? "rule file" : "rule files"}`);
		}
		return framedBlock(theme, width => ({
			header: renderStatusLine({ icon: "success", title: "cwd", meta }, theme),
			width,
		}));
	},
	renderPending(args: unknown, theme: Theme): Component {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		const label = typeof pathArg === "string" ? pathArg : "…";
		return new Text(theme.fg("toolTitle", `set_cwd ${label}`));
	},
};

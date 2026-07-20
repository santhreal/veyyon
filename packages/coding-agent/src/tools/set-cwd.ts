/**
 * Session-scoped working-directory re-root.
 *
 * Mutates the live session cwd only — never writes profile `session.workdir`.
 * Write-tier approval: prompts in ask mode, allowed under yolo/bypassAllApprovals,
 * hard deny always blocks.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage, prompt } from "@veyyon/utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import setCwdDescription from "../prompts/tools/set-cwd.md" with { type: "text" };
import { framedBlock, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const setCwdSchema = type({
	path: type("string").describe("Absolute (preferred) or session-relative directory to become the new session cwd"),
});

export type SetCwdToolInput = typeof setCwdSchema.infer;

export interface SetCwdToolDetails {
	previous: string;
	cwd: string;
}

export class SetCwdTool implements AgentTool<typeof setCwdSchema, SetCwdToolDetails> {
	readonly name = "set_cwd";
	readonly label = "SetCwd";
	readonly description = prompt.render(setCwdDescription);
	readonly parameters = setCwdSchema;
	readonly strict = true;
	readonly approval = "write" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	formatApprovalDetails = (args: unknown): string[] => {
		const raw = (args as Partial<SetCwdToolInput>)?.path;
		const requested = typeof raw === "string" ? raw.trim() : "";
		const previous = this.#session.cwd;
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

		const previous = this.#session.cwd;
		const resolved = resolveToCwd(raw, previous);
		try {
			const cwd = await this.#session.setCwd(resolved, { validate: true });
			return {
				content: [
					{
						type: "text",
						text: cwd === previous ? `Session cwd unchanged: ${cwd}` : `Session cwd set: ${previous} → ${cwd}`,
					},
				],
				details: { previous, cwd },
			};
		} catch (err) {
			throw new ToolError(errorMessage(err));
		}
	}
}

export const setCwdToolRenderer = {
	name: "set_cwd",
	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		const label = typeof pathArg === "string" ? pathArg : "…";
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
		const line =
			details && details.previous !== details.cwd
				? `${details.previous} → ${details.cwd}`
				: (details?.cwd ?? "cwd");
		return framedBlock(theme, width => ({
			header: renderStatusLine({ icon: "success", title: "cwd", meta: [line] }, theme),
			width,
		}));
	},
	renderPending(args: unknown, theme: Theme): Component {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		const label = typeof pathArg === "string" ? pathArg : "…";
		return new Text(theme.fg("toolTitle", `set_cwd ${label}`));
	},
};

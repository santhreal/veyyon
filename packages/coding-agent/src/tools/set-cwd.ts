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
	/** The path string as it arrived, so the transcript can show what was asked for. */
	requested: string;
}

export class SetCwdTool implements AgentTool<typeof setCwdSchema, SetCwdToolDetails> {
	readonly name = "set_cwd";
	readonly label = "SetCwd";
	// Gate the Argot paragraph on `argot.enabled`: the `argot_load` tool is only
	// registered when Argot is on (off by default), so an unconditional mention
	// would advertise a tool absent from the toolset. Rendered in the constructor
	// because a field initializer cannot see `#session` yet.
	readonly description: string;
	readonly parameters = setCwdSchema;
	readonly strict = true;
	readonly approval = "write" as const;
	// Discoverable, not essential: most sessions never re-root, and an unannotated
	// built-in falls through `filterInitialToolsForDiscoveryAll`'s "not a built-in"
	// branch, which keeps it permanently active AND hides it from the discovery
	// listing. Both halves of that were wrong for this tool.
	readonly loadMode = "discoverable";
	readonly summary = "Change the session's working directory for the rest of the session";
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(setCwdDescription, {
			argot: session.settings.get("argot.enabled") === true,
		});
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
			// Both branches state the END STATE, and both echo the path that was
			// actually received. The old no-op text read "Session cwd unchanged: X",
			// which a model asking for X reads as "your call did not take effect" —
			// so it retries, gets the same line, and loops. Nothing in that message
			// let it check whether the argument it sent was the argument that
			// arrived, which is the other half of the loop.
			return {
				content: [
					{
						type: "text",
						text:
							cwd === previous
								? `Session cwd is ${cwd}. Your requested path ${JSON.stringify(raw)} resolved to that same directory, so nothing needed to change. This call succeeded; do not retry it.`
								: `Session cwd is now ${cwd} (previously ${previous}). Your requested path ${JSON.stringify(raw)} resolved to it. This change is session-scoped and ephemeral; a per-profile default working directory is the session.workdir setting, not this tool.`,
					},
				],
				details: { previous, cwd, requested: raw },
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
		// A no-op used to render exactly like a real move: the same green frame
		// naming the same directory. Reading back a run of retries, there was no
		// way to tell a change from a repeat of the same no-op.
		const line = !details
			? "cwd"
			: details.previous !== details.cwd
				? `${details.previous} → ${details.cwd}`
				: `${details.cwd} (already here)`;
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

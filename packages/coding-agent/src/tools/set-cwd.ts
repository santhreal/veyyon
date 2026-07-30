/**
 * Session-scoped working-directory re-root.
 *
 * Mutates the live session cwd only — never writes profile `session.workdir`.
 * Write-tier approval: prompts in ask mode, allowed under yolo/bypassAllApprovals,
 * hard deny always blocks. It is also bound by the cwd boundary like any other
 * filesystem tool, so re-rooting OUT of the current cwd asks even in auto-edit,
 * where the write tier alone would have allowed it. See setCwdFilesystemTargets.
 */

import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage, prompt } from "@veyyon/utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import { framedBlock, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { SET_CWD_TOOL_NAME } from "./reroot-hint";
import { ToolError, toolFailure } from "./tool-errors";

const setCwdSchema = type({
	path: type("string").describe("Absolute (preferred) or session-relative directory to become the new session cwd"),
});

export type SetCwdToolInput = typeof setCwdSchema.infer;

/**
 * The directory this call would re-root the session to, so the cwd boundary
 * applies to `set_cwd` itself.
 *
 * Without this, `set_cwd` was the one write-tier tool that could DEFEAT the
 * boundary rather than be bound by it. In `auto-edit`, the rung whose whole
 * contract is "workspace writes are free, everything else asks", the write tier
 * auto-approves, so `set_cwd <parent-of-cwd>` needed no prompt and every
 * subsequent write was then trivially "inside cwd". One unremarkable call turned
 * a confined session into an unconfined one, and nothing in the transcript read
 * as an escape. (A bare `/` was never the escape it looks like: `resolveToCwd`
 * treats it as the workspace-root alias, so it resolves back to cwd.)
 *
 * Declaring the target routes the re-root through the same single chokepoint as
 * every other filesystem call, which gives exactly the right asymmetry for free:
 * NARROWING to a subdirectory stays inside cwd and never prompts, while moving
 * to a parent or a sibling escapes and asks. yolo bypasses this as it bypasses
 * all permission.
 */
export function setCwdFilesystemTargets(args: unknown): string[] {
	const raw = (args as Partial<SetCwdToolInput> | null)?.path;
	return typeof raw === "string" && raw.trim().length > 0 ? [raw.trim()] : [];
}

export interface SetCwdToolDetails {
	previous: string;
	cwd: string;
	/** The path string as it arrived, so the transcript can show what was asked for. */
	requested: string;
	/** Rule files that apply here and did not apply at `previous`. */
	rulesApplied?: string[];
	/** Rule files that applied at `previous` and do not apply here. */
	rulesDropped?: string[];
	/** Rule files that apply in both directories. */
	rulesUnchanged?: number;
}

interface RuleChange {
	/** Short lines appended to the tool result. Never rule file CONTENT. */
	lines: string[];
	applied: string[];
	dropped: string[];
	unchanged: number;
}

/**
 * Describe how the rule files in effect changed across a re-root.
 *
 * NAMES ONLY, NEVER CONTENT. An earlier version of this inlined the text of every
 * newly applicable rule file, which was the wrong instinct: it spends context on
 * something the session already has a channel for. `loadProjectContextFiles` walks
 * up from cwd, so once the cwd has moved the next system-prompt build carries the
 * new project's rules by itself, in the `<context>` block where they belong and
 * where they are cached. Paying for them a second time in a tool result buys
 * nothing and crowds out the work.
 *
 * What the result IS for is telling the model that the governing rules moved, and
 * which ones, so it knows to stop applying the old project's conventions. That is
 * a few short lines regardless of how large the files are.
 */
async function describeRuleChange(previous: string, cwd: string): Promise<RuleChange> {
	const { loadProjectContextFiles } = await import("../system-prompt");
	const [before, after] = await Promise.all([
		loadProjectContextFiles({ cwd: previous }),
		loadProjectContextFiles({ cwd }),
	]);

	const beforePaths = new Set(before.map(file => file.path));
	const afterPaths = new Set(after.map(file => file.path));
	const applied = after.filter(file => !beforePaths.has(file.path)).map(file => file.path);
	const dropped = before.filter(file => !afterPaths.has(file.path)).map(file => file.path);
	const change: RuleChange = { lines: [], applied, dropped, unchanged: after.length - applied.length };

	if (applied.length === 0 && dropped.length === 0) {
		change.lines = ["The rule files in effect are unchanged."];
		return change;
	}

	const lines: string[] = [];
	if (applied.length > 0) {
		lines.push(
			`Rule files now in effect here, which were not before: ${applied.join(", ")}. Follow them for the rest of the session.`,
		);
	}
	if (dropped.length > 0) {
		lines.push(`No longer in effect: ${dropped.join(", ")}. Stop applying them.`);
	}
	change.lines = lines;
	return change;
}

export class SetCwdTool implements AgentTool<typeof setCwdSchema, SetCwdToolDetails> {
	readonly name = SET_CWD_TOOL_NAME;
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

		// Resolved before it is used OR shown. `previous` is echoed back to the model in every branch
		// below, and a relative one made a successful re-root read as `Session cwd is now .
		// (previously .)`. The session is the authority and now always answers absolute, so this is
		// belt and braces for a `ToolSession` supplied by an embedder rather than by `sdk.ts`.
		const previous = path.resolve(this.#session.cwd);
		const resolved = resolveToCwd(raw, previous);
		let cwd: string;
		try {
			cwd = await this.#session.setCwd(resolved, { validate: true });
		} catch (err) {
			throw toolFailure(err);
		}

		// Both branches state the END STATE as an explicit pair of absolute paths, and both echo the
		// path that was actually received. Two earlier wordings each lost half of that. "Session cwd
		// unchanged: X" read as "your call did not take effect", so the model retried and looped.
		// "Session cwd is now X (previously Y)" buries the move inside a parenthetical, and when
		// either value was relative it degenerated to "Session cwd is now . (previously .)" — a
		// successful re-root naming neither end, which is what a reader then has to guess at. An
		// arrow between two resolved paths cannot degenerate that way. Each branch also says what
		// to do next: the single most common follow-up is listing the new root, and a model that
		// re-roots and then does not know relative paths moved is the other half of the same loop.
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
			// A no-op goes through the SAME description, rather than asserting an empty rule state of its own.
			// It used to report `rulesUnchanged: 0`, which is simply false: user-level rule files apply from any
			// directory, so a session that never moved still has rules in effect, and a reader of the details
			// saw a count that said otherwise. Passing `previous === cwd` here yields no applied and no dropped
			// files and the real unchanged COUNT, so both branches say the same true thing about rules and
			// there is one place that decides what that sentence is.
			const change = await describeRuleChange(previous, cwd);
			lines.push("", ...change.lines);
			details.rulesApplied = change.applied;
			details.rulesDropped = change.dropped;
			details.rulesUnchanged = change.unchanged;
		} catch (err) {
			// The re-root itself SUCCEEDED, so throwing here would tell the model the
			// opposite of what happened and invite a retry that changes nothing. Report
			// it in the result instead, and report it loudly: a session that quietly
			// carries the old project's rules into a new directory is the exact failure
			// this block exists to prevent, and it is invisible from the outside.
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
		// The rule delta is the part of a re-root that changes how the agent behaves,
		// so it belongs on the status line rather than only in the model's copy of the
		// result. A move that silently swapped the governing AGENTS.md looked
		// identical to one that changed nothing.
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

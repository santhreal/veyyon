/**
 * Session-scoped working-directory re-root.
 *
 * Mutates the live session cwd only — never writes profile `session.workdir`.
 * Write-tier approval: prompts in ask mode, allowed under yolo/bypassAllApprovals,
 * hard deny always blocks. It is also bound by the cwd boundary like any other
 * filesystem tool, so re-rooting OUT of the current cwd asks even in auto-edit,
 * where the write tier alone would have allowed it. See setCwdFilesystemTargets.
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

/**
 * How many bytes of newly-applicable rule text this result will inline.
 *
 * Rule files are usually a few KB and inlining them is the point: see
 * {@link describeRuleChange}. A repository with a very large AGENTS.md is the
 * exception, and silently dropping it would be the worst outcome, so anything
 * past the budget is still LISTED with its size and an instruction to read it.
 * The number is deliberately larger than a typical rule file and far smaller
 * than a context window.
 */
const RULE_INLINE_BUDGET_BYTES = 16_000;

interface RuleFile {
	path: string;
	content: string;
}

interface RuleChange {
	lines: string[];
	applied: string[];
	dropped: string[];
	unchanged: number;
}

/**
 * Describe how the rule files in effect changed across a re-root, inlining the
 * ones that newly apply.
 *
 * WHY THE TOOL RESULT CARRIES THIS. Rule files (AGENTS.md, CLAUDE.md and the
 * other context layers) are discovered by walking up from the session cwd, and
 * they are baked into the system prompt when the session starts. Re-rooting
 * mid-session moves the walk's starting point, so the set of files that OUGHT to
 * apply changes immediately, while the system prompt still describes the old
 * directory.
 *
 * The interactive TUI repairs that afterwards: its `cwd_changed` handler runs
 * `applyCwdChange`, which reloads project settings and rebuilds the base system
 * prompt for the new directory. Nothing else does. An SDK session, an ACP
 * session, a headless run and a subagent all re-root with no rule reload at all,
 * so they keep following the previous project's instructions for the rest of the
 * session. Even in the TUI the repair lands on the NEXT prompt, after the turn
 * that called `set_cwd` has already continued working under the old rules.
 *
 * Putting the rules in the tool result fixes both, because a tool result is the
 * one channel every mode already has and the model reads it in the same turn. It
 * also costs nothing in prompt-cache terms: appending to the transcript leaves
 * the cached prefix intact, whereas rebuilding the system prompt invalidates it.
 *
 * Only the DELTA is reported. Re-stating rules the model is already following
 * would be the expensive, confusing option, and the interesting question after a
 * re-root is exactly "what is different here".
 */
async function describeRuleChange(previous: string, cwd: string): Promise<RuleChange> {
	const { loadProjectContextFiles } = await import("../system-prompt");
	const [before, after] = await Promise.all([
		loadProjectContextFiles({ cwd: previous }),
		loadProjectContextFiles({ cwd }),
	]);

	const beforeByPath = new Map(before.map(file => [file.path, file.content]));
	const afterPaths = new Set(after.map(file => file.path));
	// Keyed by path, with content as a tiebreak for the case where the same path
	// resolves to different bytes across the two loads. Note what this CANNOT do:
	// both loads happen now, so a rule file edited since the system prompt was built
	// looks unchanged to it. Detecting that would need the content the prompt
	// actually carries, which is not recorded anywhere the tool can reach.
	const applied: RuleFile[] = after.filter(file => beforeByPath.get(file.path) !== file.content);
	const dropped = before.filter(file => !afterPaths.has(file.path));
	const unchanged = after.length - applied.length;

	const change: RuleChange = {
		lines: [],
		applied: applied.map(file => file.path),
		dropped: dropped.map(file => file.path),
		unchanged,
	};

	if (applied.length === 0 && dropped.length === 0) {
		change.lines = [
			after.length === 0
				? "No rule files (AGENTS.md and the like) apply in either directory."
				: `The same ${after.length} rule file(s) apply here as before, so your instructions are unchanged.`,
		];
		return change;
	}

	const lines = [
		`Rule files in effect changed: ${applied.length} newly apply, ${dropped.length} no longer apply, ${unchanged} unchanged.`,
	];

	if (dropped.length > 0) {
		lines.push(
			"",
			`NO LONGER IN EFFECT. These belonged to ${previous} and do not govern work in the new directory; stop following them:`,
			...dropped.map(file => `- ${file.path}`),
		);
	}

	if (applied.length > 0) {
		lines.push(
			"",
			"NEWLY IN EFFECT. Follow these for the rest of the session, exactly as if they had been in your system prompt from the start. They are listed least specific first, so a later file overrides an earlier one:",
		);
		let spent = 0;
		for (const file of applied) {
			const bytes = Buffer.byteLength(file.content, "utf8");
			if (spent + bytes > RULE_INLINE_BUDGET_BYTES) {
				// Named, sized, and actionable. A rule file dropped without saying so
				// would be the one failure this whole result exists to prevent.
				lines.push(
					"",
					`--- ${file.path} (${formatKb(bytes)}) ---`,
					`NOT INLINED: including it would exceed this result's ${formatKb(RULE_INLINE_BUDGET_BYTES)} budget for rule text. Read the file now and follow it.`,
				);
				continue;
			}
			spent += bytes;
			lines.push("", `--- ${file.path} ---`, file.content.trim());
		}
	}

	change.lines = lines;
	return change;
}

function formatKb(bytes: number): string {
	return `${(bytes / 1000).toFixed(1)} KB`;
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
	readonly filesystemTargets = (args: unknown): string[] => setCwdFilesystemTargets(args);
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
		let cwd: string;
		try {
			cwd = await this.#session.setCwd(resolved, { validate: true });
		} catch (err) {
			throw toolFailure(err);
		}

		// Both branches state the END STATE, and both echo the path that was
		// actually received. The old no-op text read "Session cwd unchanged: X",
		// which a model asking for X reads as "your call did not take effect" —
		// so it retries, gets the same line, and loops. Nothing in that message
		// let it check whether the argument it sent was the argument that
		// arrived, which is the other half of the loop.
		if (cwd === previous) {
			return {
				content: [
					{
						type: "text",
						text: `Session cwd is ${cwd}. Your requested path ${JSON.stringify(raw)} resolved to that same directory, so nothing needed to change. This call succeeded; do not retry it. The rule files in effect are unchanged.`,
					},
				],
				details: { previous, cwd, requested: raw, rulesApplied: [], rulesDropped: [], rulesUnchanged: 0 },
			};
		}

		const lines = [
			`Session cwd is now ${cwd} (previously ${previous}). Your requested path ${JSON.stringify(raw)} resolved to it. This change is session-scoped and ephemeral; a per-profile default working directory is the session.workdir setting, not this tool.`,
		];
		const details: SetCwdToolDetails = { previous, cwd, requested: raw };
		try {
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
				`WARNING: the cwd changed, but the rule files for the new directory could not be read (${errorMessage(err)}). Your instructions may still be the previous directory's. Read AGENTS.md and CLAUDE.md under ${cwd} before continuing.`,
			);
		}

		return { content: [{ type: "text", text: lines.join("\n") }], details };
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

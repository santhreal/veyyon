/**
 * Custom command types.
 *
 * Custom commands are TypeScript modules that define executable slash commands.
 * Unlike markdown commands which expand to prompts, custom commands can execute
 * arbitrary logic with full access to the hook context.
 */
import type * as arktype from "arktype";
import type * as zod from "zod/v4";
import type { ExecOptions, ExecResult, HookCommandContext } from "../../extensibility/hooks/types";
import type * as PiCodingAgent from "../../index";
import type * as TypeBox from "../typebox";

// Re-export for custom commands to use
export type { ExecOptions, ExecResult, HookCommandContext };

/**
 * API passed to custom command factory.
 * Similar to HookAPI but focused on command needs.
 */
export interface CustomCommandAPI {
	/** Current working directory */
	cwd: string;
	/** Execute a shell command */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** Injected legacy typebox shim (legacy/compat — prefer `arktype`). */
	typebox: typeof TypeBox;
	/** Injected arktype module for validation in custom commands. */
	arktype: typeof arktype;
	/** Injected zod/v4 module for canonical command validation. */
	zod: typeof zod;
	/** Injected coding-agent exports */
	pi: typeof PiCodingAgent;
}

/**
 * What a BUNDLED command may use: everything an author gets except `pi`.
 *
 * The two commands veyyon ships (`/green`, `/review`) live in this repository and reach the codebase by
 * importing it, so they have no use for the injected package namespace -- and providing it is expensive.
 * `pi` is the whole package barrel, which re-exports every mode and every component, and
 * `loadCustomCommands` runs on every launch to register the bundled pair. Typing them against this narrower
 * shape is what lets the loader skip loading the barrel entirely when a project has no custom commands of
 * its own, which is almost every project. Authors still get the full {@link CustomCommandAPI}.
 */
export type BundledCommandAPI = Omit<CustomCommandAPI, "pi">;

/**
 * Custom command definition.
 *
 * Commands can either:
 * - Return a string to be sent to the LLM as a prompt
 * - Return void/undefined to do nothing (fire-and-forget)
 *
 * @example
 * ```typescript
 * const factory: CustomCommandFactory = (pi) => ({
 *	  name: "deploy",
 *	  description: "Deploy current branch to staging",
 *	  async execute(args, ctx) {
 *		 const env = args[0] || "staging";
 *		 const confirmed = await ctx.ui.confirm("Deploy", `Deploy to ${env}?`);
 *		 if (!confirmed) return;
 *
 *		 const result = await pi.exec("./deploy.sh", [env]);
 *		 if (result.exitCode !== 0) {
 *			ctx.ui.notify(`Deploy failed: ${result.stderr}`, "error");
 *			return;
 *		 }
 *
 *		 ctx.ui.notify("Deploy successful!", "info");
 *		 // No return = no prompt sent to LLM
 *	  }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Return a prompt to send to the LLM
 * const factory: CustomCommandFactory = (pi) => ({
 *	  name: "git:status",
 *	  description: "Show git status and suggest actions",
 *	  async execute(args, ctx) {
 *		 const result = await pi.exec("git", ["status", "--porcelain"]);
 *		 return `Here's the git status:\n\`\`\`\n${result.stdout}\`\`\`\nSuggest what to do next.`;
 *	  }
 * });
 * ```
 */
export interface CustomCommand {
	/** Command name (can include namespace like "git:commit") */
	name: string;
	/** Description shown in command autocomplete */
	description: string;
	/**
	 * Subagent types this command's prompt names outright, granted for the turn it
	 * starts even when those agents are disabled.
	 *
	 * `subagent.agents.<name>.enabled` governs THE MODEL: enabled means the model
	 * may choose that agent on its own initiative. It is not meant to govern the
	 * person typing, and `/review` is the case that proves it — its prompt says
	 * `agent: "reviewer"`, and someone running `/review` is asking for a review,
	 * not asking the model to decide whether reviewing is worthwhile. Without this
	 * declaration the command would break on a stock install, where every bundled
	 * specialist ships disabled.
	 *
	 * DECLARED HERE, STATICALLY, ON PURPOSE. The grant is scoped to the turn the
	 * command starts and is readable next to the command's name, so "which commands
	 * can reach a disabled agent" is a question you answer by grepping this field.
	 * The alternative — letting a handler grant agents while it runs — is how a
	 * narrow exception becomes a general escape hatch, and a general escape hatch is
	 * the old "disabled but still runs" state with extra steps.
	 *
	 * Omit it for the overwhelming majority of commands, which spawn nothing.
	 */
	spawnsAgents?: readonly string[];
	/**
	 * Execute the command.
	 * @param args - Parsed command arguments
	 * @param ctx - Command context with UI and session control
	 * @returns String to send as prompt, or void for fire-and-forget
	 */
	execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> | string | undefined;
}

/**
 * Factory function that creates custom command(s).
 * Can return a single command or an array of commands.
 */
export type CustomCommandFactory = (
	api: CustomCommandAPI,
) => CustomCommand | CustomCommand[] | Promise<CustomCommand | CustomCommand[]>;

/** Source of a loaded custom command */
export type CustomCommandSource = "bundled" | "user" | "project";

/** Loaded custom command with metadata */
export interface LoadedCustomCommand {
	/** Original path to the command module */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** The command definition */
	command: CustomCommand;
	/** Where the command was loaded from */
	source: CustomCommandSource;
}

/** Result from loading custom commands */
export interface CustomCommandsLoadResult {
	commands: LoadedCustomCommand[];
	errors: Array<{ path: string; error: string }>;
}

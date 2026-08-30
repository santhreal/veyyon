/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 */
// Subpath import, not the barrel: this module is in cli.ts's pre-profile
// import graph (via profile-bootstrap), and the barrel loads dotenv at import
// time — before `setProfile` picks the profile agent dir (profile-cli.test.ts).

import type { CommandEntry } from "@veyyon/utils/cli";
import { levenshteinDistance } from "@veyyon/utils/levenshtein";
import * as logger from "@veyyon/utils/logger";
import { flagConsumesValue } from "./cli/flag-tables";

export const commands: CommandEntry[] = [
	{
		name: "launch",
		load: () => logger.time("import:commands/launch", () => import("./commands/launch").then(m => m.default)),
		summary: { description: "AI coding assistant", hidden: true },
	},
	{
		name: "acp",
		load: () => import("./commands/acp").then(m => m.default),
		summary: { description: "Run Veyyon as an ACP (Agent Client Protocol) server over stdio" },
	},
	{
		name: "auth-broker",
		load: () => import("./commands/auth-broker").then(m => m.default),
		summary: { description: "Manage the veyyon auth-broker (credential vault)" },
	},
	{
		name: "auth-gateway",
		load: () => import("./commands/auth-gateway").then(m => m.default),
		summary: { description: "Run an auth-gateway forward proxy backed by the configured broker" },
	},
	{
		name: "agents",
		load: () => import("./commands/agents").then(m => m.default),
		summary: { description: "Manage bundled task agents" },
	},
	{
		name: "bench/throughput",
		load: () => import("./commands/bench").then(m => m.default),
		summary: {
			description: "Benchmark models with the same prompt: time-to-first-token and generation throughput (tokens/s)",
		},
	},
	{
		name: "commit",
		load: () => import("./commands/commit").then(m => m.default),
		summary: { description: "Generate a commit message and update changelogs" },
	},
	{
		name: "completions",
		load: () => import("./commands/completions").then(m => m.default),
		summary: { description: "Print a shell completion script (bash, zsh, fish, or powershell)" },
	},
	{
		name: "__complete",
		load: () => import("./commands/complete").then(m => m.default),
		summary: { description: "", hidden: true },
	},
	{
		name: "config",
		load: () => import("./commands/config").then(m => m.default),
		summary: { description: "Manage configuration settings" },
	},
	{
		name: "dry-balance",
		load: () => import("./commands/dry-balance").then(m => m.default),
		summary: { description: "Dry-run OAuth account balancing across random session ids", devTool: true },
	},
	{
		name: "gc",
		load: () => import("./commands/gc").then(m => m.default),
		summary: { description: "Run storage garbage collection" },
	},
	{
		name: "grep",
		load: () => import("./commands/grep").then(m => m.default),
		summary: { description: "Run the standalone native text-search probe", devTool: true },
	},
	{
		name: "gallery",
		load: () => import("./commands/gallery").then(m => m.default),
		summary: {
			description: "Preview tool renderers across streaming, in-progress, success, and failure states",
			devTool: true,
		},
	},
	{
		name: "grievances",
		load: () => import("./commands/grievances").then(m => m.default),
		summary: { description: "View, clean, or push reported tool issues (auto-QA grievances)", devTool: true },
	},
	{
		name: "install",
		load: () => import("./commands/install").then(m => m.default),
		summary: { description: "Install or link an extension package (alias of `plugin install`/`plugin link`)" },
	},
	{
		name: "join",
		load: () => import("./commands/join").then(m => m.default),
		summary: { description: "Join a shared collab session (same as /join)" },
	},
	{
		name: "licenses",
		load: () => import("./commands/licenses").then(m => m.default),
		summary: { description: "Print Veyyon and third-party license notices" },
	},
	{
		name: "models",
		load: () => import("./commands/models").then(m => m.default),
		summary: { description: "List, search, and refresh available models" },
	},
	{
		name: "plugin",
		load: () => import("./commands/plugin").then(m => m.default),
		summary: { description: "Manage plugins (install, uninstall, list, etc.)" },
	},
	{
		name: "profile",
		load: () => import("./commands/profile").then(m => m.default),
		aliases: ["profiles"],
		summary: { description: "List, create, or remove self-contained profiles" },
	},
	{
		name: "prompt",
		load: () => import("./commands/prompt").then(m => m.default),
		summary: { description: "Print the assembled system prompt, or a breakdown of what it costs" },
	},
	{
		name: "say",
		load: () => import("./commands/say").then(m => m.default),
		summary: { description: "Synthesize text with the local TTS engine and play it through the speakers" },
	},
	{
		name: "session",
		load: () => import("./commands/session").then(m => m.default),
		aliases: ["sessions"],
		summary: { description: "Study a stored session (timing, tool cost, turn cadence)" },
	},
	{
		name: "setup",
		load: () => import("./commands/setup").then(m => m.default),
		summary: { description: "Run onboarding setup or install dependencies for optional features" },
	},
	{
		name: "shell",
		load: () => import("./commands/shell").then(m => m.default),
		summary: { description: "Interactive shell console" },
	},
	{
		name: "stats",
		load: () => import("./commands/stats").then(m => m.default),
		summary: { description: "View usage statistics" },
	},
	{
		name: "read",
		load: () => import("./commands/read").then(m => m.default),
		summary: { description: "Show what the read tool will return for a path, URL, or internal URI", devTool: true },
	},
	{
		name: "ssh",
		load: () => import("./commands/ssh").then(m => m.default),
		summary: { description: "Manage SSH host configurations" },
	},
	{
		name: "rollback",
		load: () => import("./commands/rollback").then(m => m.default),
		summary: { description: "Move this install to another published version" },
	},
	{
		name: "update",
		load: () => import("./commands/update").then(m => m.default),
		summary: { description: "Check for and install updates" },
	},
	{
		name: "usage",
		load: () => import("./commands/usage").then(m => m.default),
		summary: { description: "Show provider usage limits for every authenticated account" },
	},
	{
		name: "tiny-models",
		load: () => import("./commands/tiny-models").then(m => m.default),
		summary: { description: "Download tiny local models (session titles + memory)" },
	},
	{
		name: "token",
		load: () => import("./commands/token").then(m => m.default),
		summary: { description: "Get the API key or OAuth token for a provider" },
	},
	{
		name: "trust",
		load: () => import("./commands/trust").then(m => m.default),
		summary: { description: "Approve, refuse or review the project code veyyon is allowed to load" },
	},
	{
		name: "ttsr",
		load: () => import("./commands/ttsr").then(m => m.default),
		summary: { description: "Inspect and test Time-Traveling Stream Rules (TTSR)", devTool: true },
	},
	{
		name: "worktree",
		load: () => import("./commands/worktree").then(m => m.default),
		aliases: ["wt"],
		summary: { description: "List or clear agent-managed git worktrees (~/.veyyon/wt)" },
	},
	{
		name: "search",
		load: () => import("./commands/web-search").then(m => m.default),
		aliases: ["q"],
		summary: {
			description: "Run a web search through a configured provider and show the raw results",
			devTool: true,
		},
	},
];

// Documented-looking plugin-management verbs that are NOT registered top-level
// commands. Without a guard `resolveCliArgv` rewrites e.g. `veyyon list` to
// `veyyon launch list`, silently forwarding the bare verb to the model as a prompt
// instead of managing plugins (#2935; same class as the `install` leak fixed in
// #1496/#1498). A bare (single-arg) use gets a hint pointing at the real
// `veyyon plugin <action>` command; multi-word invocations still fall through to
// `launch`, so genuine prompts that merely begin with one of these words work.
const RESERVED_TOP_LEVEL_WORDS = new Map<string, string>([
	[
		"extensions",
		'`veyyon extensions` is not a management command. Use `veyyon plugin list` / `veyyon plugin install`, or run `veyyon launch extensions` if you meant to send "extensions" as a prompt.',
	],
	[
		"list",
		'`veyyon list` is not a top-level command. Use `veyyon plugin list` to list installed plugins, or run `veyyon launch list` if you meant to send "list" as a prompt.',
	],
	[
		"remove",
		'`veyyon remove` is not a top-level command. Use `veyyon plugin uninstall <name>` to remove a plugin, or run `veyyon launch remove` if you meant to send "remove" as a prompt.',
	],
]);

export function reservedTopLevelWordMessage(first: string | undefined, argc = 1): string | undefined {
	if (argc !== 1 || !first || first.startsWith("-") || first.startsWith("@")) return undefined;
	return RESERVED_TOP_LEVEL_WORDS.get(first);
}

/**
 * "Did you mean" for a bare single token that is a near-miss of a registered
 * subcommand (typo within edit distance 2, or a prefix like `auth` →
 * `auth-broker`). Without this the token silently falls through to `launch`
 * and gets sent to the model as a one-word prompt — the same leak class as
 * #1496/#2935, e.g. `veyyon auth` starting a paid LLM session on the word
 * "auth". Multi-word invocations are untouched: genuine prompts win there.
 * Callers decide what counts as "bare": `resolveCliArgv` passes the sole
 * positional even when flags surround it (`veyyon updte --print` is the same
 * leak, just with a flag attached).
 */
export function nearMissSubcommandMessage(first: string | undefined, argc = 1): string | undefined {
	if (argc !== 1 || !first || first.length < 3 || first.startsWith("-") || first.startsWith("@")) return undefined;
	// Short tokens only match at distance 1: at distance 2 a 5-letter English
	// word collides with unrelated commands ("hello" is 2 edits from "shell"),
	// which would reject genuine one-word prompts like `veyyon -p hello`.
	const maxDistance = first.length <= 5 ? 1 : 2;
	const candidates: string[] = [];
	for (const entry of commands) {
		for (const name of [entry.name, ...(entry.aliases ?? [])]) {
			if (name.startsWith("__")) continue;
			if (name.startsWith(first) || levenshteinDistance(first, name) <= maxDistance) {
				candidates.push(name);
			}
		}
	}
	if (candidates.length === 0) return undefined;
	const suggestions = candidates
		.slice(0, 3)
		.map(name => `\`veyyon ${name}\``)
		.join(", ");
	return `\`veyyon ${first}\` is not a command. Did you mean ${suggestions}? To send "${first}" as a prompt instead, run \`veyyon launch ${first}\`.`;
}

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/**
 * The single positional token in argv, if there is exactly one — flags (and
 * any value they consume) are skipped with the launch parser's contract. Two
 * or more positionals mean a genuine prompt; an end-of-options `--` is an
 * explicit "everything after is prompt" and also disqualifies.
 */
function solePositional(argv: string[]): string | undefined {
	let sole: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return undefined;
		if (arg.startsWith("-")) {
			if (flagConsumesValue(arg, argv[index + 1])) index += 1;
			continue;
		}
		if (sole !== undefined) return undefined;
		sole = arg;
	}
	return sole;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command with the flags preserved, and forward everything else to
 * `launch` (#2970).
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(first, argv.length);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`veyyon --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front and keep the leading flags as its own
	// argv; the command's parser then applies them. Genuine launch prompts (no
	// trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		return { argv: [argv[subIndex], ...argv.slice(0, subIndex), ...argv.slice(subIndex + 1)] };
	}
	// The near-miss guard covers any invocation whose only positional is the
	// suspect token — `veyyon updte --print` is the same paid-prompt leak as a
	// bare `veyyon updte`, just with a flag attached.
	const sole = solePositional(argv);
	const nearMissMessage = sole === undefined ? undefined : nearMissSubcommandMessage(sole, 1);
	if (nearMissMessage) return { error: nearMissMessage };
	return { argv: ["launch", ...argv] };
}

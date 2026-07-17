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
import { levenshteinDistance } from "@veyyon/pi-utils";
import type { CommandEntry } from "@veyyon/pi-utils/cli";
import { flagConsumesValue } from "./cli/flag-tables";

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
	{ name: "acp", load: () => import("./commands/acp").then(m => m.default) },
	{ name: "auth-broker", load: () => import("./commands/auth-broker").then(m => m.default) },
	{ name: "auth-gateway", load: () => import("./commands/auth-gateway").then(m => m.default) },
	{ name: "agents", load: () => import("./commands/agents").then(m => m.default) },
	{ name: "bench", load: () => import("./commands/bench").then(m => m.default) },
	{ name: "commit", load: () => import("./commands/commit").then(m => m.default) },
	{ name: "completions", load: () => import("./commands/completions").then(m => m.default) },
	{ name: "__complete", load: () => import("./commands/complete").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "dry-balance", load: () => import("./commands/dry-balance").then(m => m.default) },
	{ name: "gc", load: () => import("./commands/gc").then(m => m.default) },
	{ name: "grep", load: () => import("./commands/grep").then(m => m.default) },
	{ name: "gallery", load: () => import("./commands/gallery").then(m => m.default) },
	{ name: "grievances", load: () => import("./commands/grievances").then(m => m.default) },
	{ name: "install", load: () => import("./commands/install").then(m => m.default) },
	{ name: "join", load: () => import("./commands/join").then(m => m.default) },
	{ name: "models", load: () => import("./commands/models").then(m => m.default) },
	{ name: "plugin", load: () => import("./commands/plugin").then(m => m.default) },
	{ name: "profile", load: () => import("./commands/profile").then(m => m.default), aliases: ["profiles"] },
	{ name: "say", load: () => import("./commands/say").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "shell", load: () => import("./commands/shell").then(m => m.default) },
	{ name: "stats", load: () => import("./commands/stats").then(m => m.default) },
	{ name: "read", load: () => import("./commands/read").then(m => m.default) },
	{ name: "ssh", load: () => import("./commands/ssh").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "usage", load: () => import("./commands/usage").then(m => m.default) },
	{ name: "tiny-models", load: () => import("./commands/tiny-models").then(m => m.default) },
	{ name: "token", load: () => import("./commands/token").then(m => m.default) },
	{ name: "ttsr", load: () => import("./commands/ttsr").then(m => m.default) },
	{ name: "worktree", load: () => import("./commands/worktree").then(m => m.default), aliases: ["wt"] },
	{ name: "search", load: () => import("./commands/web-search").then(m => m.default), aliases: ["q"] },
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
 */
export function nearMissSubcommandMessage(first: string | undefined, argc = 1): string | undefined {
	if (argc !== 1 || !first || first.length < 3 || first.startsWith("-") || first.startsWith("@")) return undefined;
	const candidates: string[] = [];
	for (const entry of commands) {
		for (const name of [entry.name, ...(entry.aliases ?? [])]) {
			if (name.startsWith("__")) continue;
			if (name.startsWith(first) || levenshteinDistance(first, name) <= 2) {
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
	const nearMissMessage = nearMissSubcommandMessage(first, argv.length);
	if (nearMissMessage) return { error: nearMissMessage };
	return { argv: ["launch", ...argv] };
}

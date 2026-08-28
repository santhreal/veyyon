import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@veyyon/tui";
import { getActiveProfile, getProjectDir, listProfiles } from "@veyyon/utils";
import { readProfileDisplayName } from "../cli/profile-cli";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { SECRET_TUI_SUBCOMMANDS } from "../secrets/secret-command";
import { expandTilde } from "../tools/path-utils";
import { bareInvocationShowsSubcommands } from "./bare-subcommand";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
	type BuiltinSlashCommandName,
} from "./builtin-declarations";
import { BUILTIN_SLASH_COMMAND_HANDLERS } from "./builtins";
import { parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

function toSlashCommandSpec(declaration: BuiltinSlashCommandDeclaration): SlashCommandSpec {
	const spec: SlashCommandSpec = {
		name: declaration.name,
		description: declaration.description,
		...BUILTIN_SLASH_COMMAND_HANDLERS[declaration.name as BuiltinSlashCommandName],
	};
	if (declaration.aliases) spec.aliases = Array.from(declaration.aliases);
	if (declaration.allowArgs !== undefined) spec.allowArgs = declaration.allowArgs;
	if (declaration.inlineHint !== undefined) spec.inlineHint = declaration.inlineHint;
	if (declaration.acpDescription !== undefined) spec.acpDescription = declaration.acpDescription;
	if (declaration.acpInputHint !== undefined) spec.acpInputHint = declaration.acpInputHint;
	if (declaration.bareAction !== undefined) spec.bareAction = declaration.bareAction;
	if (declaration.subcommands) spec.subcommands = declaration.subcommands.map(sub => ({ ...sub }));
	return spec;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> =
	BUILTIN_SLASH_COMMAND_DECLARATIONS.map(toSlashCommandSpec);

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "./builtin-declarations";

function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null;
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

function buildProfileArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trimStart();
		if (prefix.includes(" ")) return null;
		const active = getActiveProfile() ?? "default";
		const items: AutocompleteItem[] = [];
		for (const profile of listProfiles()) {
			if (!profile.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
			const display = await readProfileDisplayName(profile.name === "default" ? undefined : profile.name);
			items.push({
				value: profile.name,
				label: profile.name,
				description:
					(profile.name === active ? "active" : "switch (fresh session)") +
					(display && display !== profile.name ? ` (${display})` : ""),
			});
		}
		for (const sub of ["list", "new ", "create ", "switch ", "rename to ", "rm ", "delete "]) {
			if (sub.startsWith(prefix.toLowerCase())) {
				items.push({ value: sub, label: sub.trim(), description: "" });
			}
		}
		return items.length > 0 ? items : null;
	};
}

const secretArgumentCompletions = (argumentPrefix: string): AutocompleteItem[] | null => {
	if (argumentPrefix.includes(" ")) return null;
	const prefix = argumentPrefix.toLowerCase();
	const matches = SECRET_TUI_SUBCOMMANDS.filter(sub => sub.name.startsWith(prefix)).map(sub => ({
		value: sub.usage === "" ? sub.name : `${sub.name} `,
		label: sub.name,
		description: sub.description,
		hint: sub.usage === "" ? undefined : sub.usage,
	}));
	return matches.length > 0 ? matches : null;
};

function buildSecretInlineHint(inlineHint: string | undefined): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		if (trimmed.length === 0) return inlineHint ?? null;
		if (trimmed.includes(" ")) {
			const typed = trimmed.slice(0, trimmed.indexOf(" ")).toLowerCase();
			const exact = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name === typed);

			return exact !== undefined && trimmed.trimEnd() === typed && exact.usage !== "" ? exact.usage : null;
		}
		const match = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name.startsWith(trimmed.toLowerCase()));
		if (match === undefined) return null;
		const remaining = match.name.slice(trimmed.length);
		return match.usage === "" ? remaining : `${remaining} ${match.usage}`;
	};
}

function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}

function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}

export const BUILTIN_SLASH_COMMAND_CATEGORIES: Readonly<Record<string, string>> = {
	settings: "setup",
	secret: "setup",
	statusline: "setup",
	welcome: "setup",
	lsp: "setup",
	setup: "setup",
	providers: "setup",
	account: "setup",
	login: "setup",
	logout: "setup",
	profile: "setup",
	mcp: "setup",
	ssh: "setup",
	extensions: "setup",
	plugins: "setup",
	"reload-plugins": "setup",
	trust: "setup",
	plan: "modes",
	"plan-review": "modes",
	vibe: "modes",
	goal: "modes",
	"guided-goal": "modes",
	loop: "modes",
	queue: "modes",
	prewalk: "modes",
	fast: "modes",
	permissions: "modes",
	yolo: "modes",
	"cpu-limit": "modes",
	pause: "modes",
	model: "model",
	switch: "model",
	effort: "model",
	force: "model",
	retry: "model",
	advisor: "model",
	share: "share",
	collab: "share",
	join: "share",
	leave: "share",
	export: "share",
	dump: "share",
	copy: "share",
	browser: "workspace",
	cwd: "workspace",
	tools: "workspace",
	agents: "workspace",
	"process-manager": "workspace",
	jobs: "workspace",
	usage: "workspace",
	stats: "workspace",
	todo: "context",
	context: "context",
	memory: "context",
	compact: "context",
	shake: "context",
	handoff: "context",
	btw: "context",
	tan: "context",
	session: "session",
	new: "session",
	fresh: "session",
	drop: "session",
	resume: "session",
	rename: "session",
	move: "session",
	branch: "session",
	fork: "session",
	tree: "session",
	exit: "session",
	quit: "session",
	changelog: "info",
	hotkeys: "info",
	debug: "info",
	omfg: "info",
};

export { BUILTIN_SLASH_COMMAND_CATEGORY_ORDER } from "./category-order";

export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		description: command.description,
		aliases: command.aliases ? Array.from(command.aliases) : undefined,
		allowArgs: command.allowArgs,
		inlineHint: command.inlineHint,
		bareAction: command.bareAction,
		subcommands: command.subcommands?.map(sub => ({ ...sub })),
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };

	if (cmd.name === "secret") {
		materialized.getArgumentCompletions = secretArgumentCompletions;
		materialized.getInlineHint = buildSecretInlineHint(cmd.inlineHint);
	} else if (cmd.subcommands) {
		materialized.getArgumentCompletions = buildArgumentCompletions(cmd.subcommands);

		const subcommandHint = buildSubcommandInlineHint(cmd.subcommands);
		const staticHint = cmd.inlineHint === undefined ? undefined : buildStaticInlineHint(cmd.inlineHint);
		materialized.getInlineHint = (argumentText: string) =>
			subcommandHint(argumentText) ?? staticHint?.(argumentText) ?? null;
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "profile") {
		materialized.getArgumentCompletions = buildProfileArgumentCompletions();
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return text.includes("://") || text.includes("code=") || text.startsWith("?");
	}
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.subcommands && bareInvocationShowsSubcommands(command, parsed.args)) {
		const subcommands = command.subcommands;
		runtime.ctx.editor.setText("");
		runtime.ctx.showSubcommandPicker(command.name, subcommands, subcommand => {
			if (subcommand.usage && subcommand.usage.trim().length > 0) {
				runtime.ctx.editor.setText(`/${command.name} ${subcommand.name} `);
				runtime.ctx.ui.requestRender();
				return;
			}

			void executeBuiltinSlashCommand(`/${command.name} ${subcommand.name}`, runtime);
		});
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshSlashCommandState();
				await ctx.session.refreshSshTool({ activateIfAvailable: true });
			},
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };

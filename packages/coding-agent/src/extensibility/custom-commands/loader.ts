/**
 * Custom command loader - loads TypeScript command modules using native Bun import.
 *
 * Dependencies (the arktype validation and coding-agent SDK) are injected via the
 * CustomCommandAPI to avoid import resolution issues with custom commands loaded from user directories.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, getAgentDir, getProjectDir, isEnoent, readdirIfPresent, reportFault } from "@veyyon/utils";
import * as arktype from "arktype";
import * as zodModule from "zod/v4";
import { getConfigDirs } from "../../config";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import { loadCodingAgentApi } from "../coding-agent-api";
import {
	factoryExportMissingMessage,
	invalidArtifactFieldMessage,
	moduleImportFailedMessage,
	nameConflictMessage,
} from "../load-failure";
import * as typebox from "../typebox";
import { GreenCommand } from "./bundled/ci-green";
import { ReviewCommand } from "./bundled/review";
import type {
	BundledCommandAPI,
	CustomCommand,
	CustomCommandAPI,
	CustomCommandFactory,
	CustomCommandSource,
	CustomCommandsLoadResult,
	LoadedCustomCommand,
} from "./types";

/**
 * Load a single command module using native Bun import.
 */
async function loadCommandModule(
	commandPath: string,
	_cwd: string,
	sharedApi: CustomCommandAPI,
): Promise<{ commands: CustomCommand[] | null; error: string | null }> {
	try {
		const module = await import(commandPath);
		const factory = (module.default ?? module) as CustomCommandFactory;

		if (typeof factory !== "function") {
			return { commands: null, error: factoryExportMissingMessage("custom command") };
		}

		const result = await factory(sharedApi);
		const commands = Array.isArray(result) ? result : [result];

		// Validate commands
		for (const cmd of commands) {
			if (!cmd.name || typeof cmd.name !== "string") {
				return {
					commands: null,
					error: invalidArtifactFieldMessage(
						"custom command",
						"name",
						"it must be a non-empty string, and it is the word typed after the slash",
					),
				};
			}
			if (!cmd.description || typeof cmd.description !== "string") {
				return {
					commands: null,
					error: invalidArtifactFieldMessage(
						"custom command",
						"description",
						`it must be a non-empty string, and it is the one line "/${cmd.name}" shows in the command list`,
					),
				};
			}
			if (typeof cmd.execute !== "function") {
				return {
					commands: null,
					error: invalidArtifactFieldMessage(
						"custom command",
						"execute",
						`it must be a function, and it is what running "/${cmd.name}" calls`,
					),
				};
			}
		}

		return { commands, error: null };
	} catch (err) {
		return { commands: null, error: moduleImportFailedMessage("custom command", errorMessage(err)) };
	}
}

export interface DiscoverCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
}

export interface DiscoverCustomCommandsResult {
	/** Paths to command modules */
	paths: Array<{ path: string; source: CustomCommandSource }>;
}

/**
 * Whether a directory under `commands/` is a MARKDOWN command tree rather than a
 * broken TypeScript one. `slash-commands.ts` loads `.md` commands and this
 * loader must not report those as missing an entry point: doing so would fire a
 * fault on every working Claude-style command directory.
 */
async function holdsMarkdownCommand(commandDir: string): Promise<boolean> {
	const entries = await readdirIfPresent(commandDir, "custom command directory");
	return entries.some(entry => entry.name.endsWith(".md"));
}

/**
 * Discover custom command modules (TypeScript slash commands).
 * Markdown slash commands are handled by core/slash-commands.ts.
 */
export async function discoverCustomCommands(
	options: DiscoverCustomCommandsOptions = {},
): Promise<DiscoverCustomCommandsResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const paths: Array<{ path: string; source: CustomCommandSource }> = [];
	const seen = new Set<string>();

	const addPath = (commandPath: string, source: CustomCommandSource): void => {
		const resolved = path.resolve(commandPath);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		paths.push({ path: resolved, source });
	};

	const commandDirs: Array<{ path: string; source: CustomCommandSource }> = [];
	if (agentDir) {
		const userCommandsDir = path.join(agentDir, "commands");
		if (fs.existsSync(userCommandsDir)) {
			commandDirs.push({ path: userCommandsDir, source: "user" });
		}
	}

	for (const entry of getConfigDirs("commands", { cwd, existingOnly: true })) {
		const source = entry.level === "user" ? "user" : "project";
		if (!commandDirs.some(d => d.path === entry.path)) {
			commandDirs.push({ path: entry.path, source });
		}
	}

	const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
	for (const { path: commandsDir, source } of commandDirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
		} catch (error) {
			if (!isEnoent(error)) {
				reportFault({
					source: "commands",
					text:
						`The custom commands directory ${commandsDir} could not be read, so none of the commands ` +
						`inside it are available in this run: ${errorMessage(error)}. ` +
						"Fix: check its permissions and whether its filesystem is mounted.",
					context: { path: commandsDir, error: String(error) },
				});
			}
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			// A LOOSE FILE IS NOT A COMMAND, AND SAYING SO IS THE POINT. This scan
			// only ever accepted `<commandsDir>/<name>/index.{ts,js,mjs,cjs}`, and
			// anything else it met it dropped without a word: a `commands/foo.ts`
			// written flat, or a `commands/foo/` holding `command.ts`, produced a
			// session with the command absent and nothing anywhere to explain it.
			// Markdown is excluded because it is not this loader's job -- a `.md`
			// slash command is loaded by `slash-commands.ts` and works.
			if (!entry.isDirectory()) {
				if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
					reportFault({
						source: "commands",
						text:
							`${path.join(commandsDir, entry.name)} is not loaded as a custom command, because a ` +
							"TypeScript command must sit in its own directory. " +
							`Fix: move it to ${path.join(commandsDir, entry.name.replace(/\.[^.]+$/, ""), "index.ts")}.`,
						context: { path: path.join(commandsDir, entry.name) },
					});
				}
				continue;
			}
			const commandDir = path.join(commandsDir, entry.name);

			let loaded = false;
			for (const filename of indexCandidates) {
				const candidate = path.join(commandDir, filename);
				if (fs.existsSync(candidate)) {
					addPath(candidate, source);
					loaded = true;
					break;
				}
			}
			if (!loaded && !(await holdsMarkdownCommand(commandDir))) {
				reportFault({
					source: "commands",
					text:
						`${commandDir} holds no command entry point, so nothing from it is available in this run. ` +
						`Fix: add ${path.join(commandDir, "index.ts")} with a default export that returns the command, ` +
						"or delete the directory so it stops being scanned.",
					context: { path: commandDir, tried: indexCandidates },
				});
			}
		}
	}

	return { paths };
}

export interface LoadCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
	/** Session CPU budget hook: processes a command's `exec` spawns join the session's budget group. */
	adoptSpawnedPid?: (pid: number) => void;
}

/**
 * Load bundled commands (shipped with veyyon).
 */
function loadBundledCommands(sharedApi: BundledCommandAPI): LoadedCustomCommand[] {
	const bundled: LoadedCustomCommand[] = [];

	// Add bundled commands here
	bundled.push({
		path: "bundled:green",
		resolvedPath: "bundled:green",
		command: new GreenCommand(sharedApi),
		source: "bundled",
	});
	bundled.push({
		path: "bundled:review",
		resolvedPath: "bundled:review",
		command: new ReviewCommand(sharedApi),
		source: "bundled",
	});

	return bundled;
}

/**
 * Discover and load custom commands from standard locations.
 */
export async function loadCustomCommands(options: LoadCustomCommandsOptions = {}): Promise<CustomCommandsLoadResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();

	const { paths } = await discoverCustomCommands({ cwd, agentDir });

	const commands: LoadedCustomCommand[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const seenNames = new Set<string>();

	// Shared API object - all commands get the same instance.
	//
	// Built WITHOUT `pi` first. That field is the whole package barrel, which re-exports every mode and
	// every component, and this function runs on every launch to register the two bundled commands --
	// neither of which uses it, since they import this repository directly. So the barrel is loaded only
	// when a project actually ships a custom command whose author expects `api.pi`.
	const bundledApi: BundledCommandAPI = {
		cwd,
		exec: (command: string, args: string[], execOptions) =>
			execCommand(
				command,
				args,
				execOptions?.cwd ?? cwd,
				options.adoptSpawnedPid ? { ...execOptions, adoptPid: options.adoptSpawnedPid } : execOptions,
			),
		typebox,
		arktype,
		zod: zodModule,
	};

	// 1. Load bundled commands first (lowest priority - can be overridden)
	for (const loaded of loadBundledCommands(bundledApi)) {
		seenNames.add(loaded.command.name);
		commands.push(loaded);
	}

	// One object for every author-written command, so a command that mutates the API sees what its
	// neighbours see. Absent entirely when there are none, which is the case that skips the barrel.
	const sharedApi: CustomCommandAPI | undefined =
		paths.length > 0 ? { ...bundledApi, pi: await loadCodingAgentApi() } : undefined;

	// 2. Load user/project commands (can override bundled)
	for (const { path: commandPath, source } of paths) {
		// `sharedApi` is defined whenever `paths` is non-empty, which is the only way this loop runs.
		const { commands: loadedCommands, error } = await loadCommandModule(
			commandPath,
			cwd,
			sharedApi as CustomCommandAPI,
		);

		if (error) {
			errors.push({ path: commandPath, error });
			continue;
		}

		if (loadedCommands) {
			for (const command of loadedCommands) {
				// Allow overriding bundled commands, but not user/project conflicts
				const existingIdx = commands.findIndex(c => c.command.name === command.name);
				if (existingIdx !== -1) {
					const existing = commands[existingIdx];
					if (existing.source === "bundled") {
						// Override bundled command
						commands.splice(existingIdx, 1);
						seenNames.delete(command.name);
					} else {
						// The loser names the WINNER's file. "conflicts with existing
						// command" left the operator holding two files and no way to
						// tell which of them is the one that is actually running.
						errors.push({
							path: commandPath,
							error: nameConflictMessage("custom command", command.name, existing.path),
						});
						continue;
					}
				}

				seenNames.add(command.name);
				commands.push({
					path: commandPath,
					resolvedPath: path.resolve(commandPath),
					command,
					source,
				});
			}
		}
	}

	return { commands, errors };
}

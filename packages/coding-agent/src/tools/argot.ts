import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL } from "argot/constants";
import { type } from "arktype";
import { loadArgotFolder, unloadArgotFolder } from "../argot-cache";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { ToolError, toolFailure } from "./tool-errors";

const folderSchema = type({
	folder_path: type("string").describe(
		"Absolute (preferred) or session-relative path to the folder to load. Argot resolves it to the nearest project it belongs to (its .git or .argot marker), never a parent that contains many projects.",
	),
});

export type ArgotFolderInput = typeof folderSchema.infer;

export interface ArgotLoadDetails {
	root: string;
	handles: number;
	requested: string;
}

export interface ArgotUnloadDetails {
	root: string;
	changed: boolean;
	requested: string;
}

type ArgotSession = NonNullable<ReturnType<NonNullable<ToolSession["getArgotSession"]>>>;

function requireArgot(session: ToolSession): ArgotSession {
	const argot = session.getArgotSession?.();
	if (argot === undefined) {
		throw new ToolError(
			"Argot shorthand is not enabled for this session, so there is nothing to load. Enable it with the `argot.enabled` setting.",
		);
	}
	return argot;
}

export class ArgotLoadTool implements AgentTool<typeof folderSchema, ArgotLoadDetails> {
	readonly name = ARGOT_LOAD_TOOL;
	readonly label = "ArgotLoad";
	readonly approval = "write" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const raw = (args as Partial<ArgotFolderInput>).folder_path;
		const trimmed = typeof raw === "string" ? raw.trim() : "";
		const resolved = trimmed ? resolveToCwd(trimmed, this.#session.cwd) : "(missing)";
		return [`Folder: ${trimmed || "(missing)"}${trimmed && resolved !== trimmed ? ` (${resolved})` : ""}`];
	};
	readonly description =
		"Load a folder's Argot shorthand so you can write its long paths and identifiers as short `§handle` tokens. Resolves the folder to its own project (nearest .git or .argot), reads or builds that project's dictionary, and teaches you its handles. Load the narrowest folder that is your work unit, not a parent holding many projects. Every handle expands losslessly, so this only saves tokens.";
	readonly parameters = folderSchema;
	readonly strict = true;
	readonly summary = "Load a folder's Argot shorthand so its paths can be written as short handles";
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: ArgotFolderInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ArgotLoadDetails>,
	): Promise<AgentToolResult<ArgotLoadDetails>> {
		const requested = typeof params.folder_path === "string" ? params.folder_path.trim() : "";
		if (!requested) {
			throw new ToolError("folder_path is required");
		}
		const argot = requireArgot(this.#session);
		const folder = resolveToCwd(requested, this.#session.cwd);

		let loaded: Awaited<ReturnType<typeof loadArgotFolder>>;
		try {
			loaded = await loadArgotFolder(argot, folder, signal, this.#session.settings.get("argot.tokenBudget"));
		} catch (err) {
			throw toolFailure(err);
		}

		if (loaded === undefined) {
			return {
				content: [
					{
						type: "text",
						text: `No project marker (.git or .argot) found at or above ${folder}, so there is no shorthand to load. Argot scopes a dictionary to a project; drop an empty .argot file at the folder's root to opt a non-git project in.`,
					},
				],
				details: { root: folder, handles: 0, requested },
			};
		}

		if (loaded.handles > 0) {
			await this.#session.refreshBaseSystemPrompt?.("argot-load");
		}

		return {
			content: [
				{
					type: "text",
					text:
						loaded.handles > 0
							? `Loaded Argot shorthand for ${loaded.root} (${loaded.handles} handles). You may now write its paths and identifiers as §handle tokens; each expands to its full text before it leaves your history.`
							: `Resolved ${loaded.root}, but its dictionary is empty (no string recurs often enough to earn a handle), so there is nothing new to write in shorthand. Decoding is on regardless.`,
				},
			],
			details: { root: loaded.root, handles: loaded.handles, requested },
		};
	}
}

export class ArgotUnloadTool implements AgentTool<typeof folderSchema, ArgotUnloadDetails> {
	readonly name = ARGOT_UNLOAD_TOOL;
	readonly label = "ArgotUnload";
	readonly approval = "read" as const;
	readonly description =
		"Stop teaching a folder's Argot shorthand: you are no longer shown its handles, so you write its paths in full again. Handles you already wrote keep expanding, so this is always safe. Use it when you are done with a folder loaded earlier and want to keep the taught handle table small.";
	readonly parameters = folderSchema;
	readonly strict = true;
	readonly summary = "Stop being taught a folder's Argot shorthand; handles already written keep expanding";
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: ArgotFolderInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ArgotUnloadDetails>,
	): Promise<AgentToolResult<ArgotUnloadDetails>> {
		const requested = typeof params.folder_path === "string" ? params.folder_path.trim() : "";
		if (!requested) {
			throw new ToolError("folder_path is required");
		}
		const argot = requireArgot(this.#session);
		const folder = resolveToCwd(requested, this.#session.cwd);

		const result = unloadArgotFolder(argot, folder);
		if (result === undefined) {
			return {
				content: [
					{
						type: "text",
						text: `No project marker (.git or .argot) found at or above ${folder}, so there was nothing loaded to unload.`,
					},
				],
				details: { root: folder, changed: false, requested },
			};
		}

		if (result.changed) {
			await this.#session.refreshBaseSystemPrompt?.("argot-unload");
		}

		return {
			content: [
				{
					type: "text",
					text: result.changed
						? `Stopped teaching Argot shorthand for ${result.root}. Any handles you already wrote still expand; you just will not be shown new ones for this project.`
						: `Argot shorthand for ${result.root} was not loaded (or was already not being taught), so nothing changed. Decoding of any handle already written stays on.`,
				},
			],
			details: { root: result.root, changed: result.changed, requested },
		};
	}
}

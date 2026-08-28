import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import * as arktype from "arktype";
import * as zodModule from "zod/v4";
import { hookCapability } from "../../capability/hook";
import type { Hook } from "../../discovery";
import { loadCapability } from "../../discovery";
import { execCommand, withSessionCpuExec } from "../../exec/exec";
import type { CustomMessagePayload } from "../../session/messages";
import { loadCodingAgentApi } from "../coding-agent-api";
import { factoryExportMissingMessage, moduleImportFailedMessage } from "../load-failure";
import * as typebox from "../typebox";
import { resolvePath, withExitGuard } from "../utils";
import type { ExecOptions, HookAPI, HookFactory, HookMessageRenderer, RegisteredCommand } from "./types";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: CustomMessagePayload<T>,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type { BranchHandler, NavigateTreeHandler, NewSessionHandler } from "../session-handler-types";

export interface LoadedHook {
	path: string;
	resolvedPath: string;
	handlers: Map<string, HandlerFn[]>;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}

export interface LoadHooksResult {
	hooks: LoadedHook[];
	errors: Array<{ path: string; error: string }>;
}

async function createHookAPI(
	handlers: Map<string, HandlerFn[]>,
	cwd: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<{
	api: HookAPI;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}> {
	let sendMessageHandler: SendMessageHandler | null = null;
	let appendEntryHandler: AppendEntryHandler | null = null;
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();

	const api = {
		on(event: string, handler: HandlerFn): void {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		},
		sendMessage<T = unknown>(
			message: CustomMessagePayload<T>,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		): void {
			if (!sendMessageHandler) {
				throw new Error("sendMessage handler not initialized");
			}
			sendMessageHandler(message, options);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			if (!appendEntryHandler) {
				throw new Error("appendEntry handler not initialized");
			}
			appendEntryHandler(customType, data);
		},
		registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as HookMessageRenderer);
		},
		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(
				command,
				args,
				options?.cwd ?? cwd,
				withSessionCpuExec(options, adoptSpawnedPid, gateSpawn, "a hook command"),
			);
		},
		logger,
		typebox,
		arktype: arktype.Type,
		zod: zodModule,
		pi: await loadCodingAgentApi(),
	} as HookAPI;

	return {
		api,
		messageRenderers,
		commands,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
	};
}

async function loadHook(
	hookPath: string,
	cwd: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, cwd);

	try {
		const module = await withExitGuard(() => import(resolvedPath));
		const factory = module.default as HookFactory;

		if (typeof factory !== "function") {
			return { hook: null, error: factoryExportMissingMessage("hook") };
		}

		const handlers = new Map<string, HandlerFn[]>();
		const { api, messageRenderers, commands, setSendMessageHandler, setAppendEntryHandler } = await createHookAPI(
			handlers,
			cwd,
			adoptSpawnedPid,
			gateSpawn,
		);

		await withExitGuard(async () => factory(api));

		return {
			hook: {
				path: hookPath,
				resolvedPath,
				handlers,
				messageRenderers,
				commands,
				setSendMessageHandler,
				setAppendEntryHandler,
			},
			error: null,
		};
	} catch (err) {
		return { hook: null, error: moduleImportFailedMessage("hook", errorMessage(err)) };
	}
}

export async function loadHooks(
	paths: string[],
	cwd: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const hookPath of paths) {
		const { hook, error } = await loadHook(hookPath, cwd, adoptSpawnedPid, gateSpawn);

		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}

		if (hook) {
			hooks.push(hook);
		}
	}

	return { hooks, errors };
}

export async function discoverAndLoadHooks(
	configuredPaths: string[],
	cwd: string,
	agentDir?: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadHooksResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	const discovered = await loadCapability<Hook>(hookCapability.id, { cwd, agentDir });
	addPaths(discovered.items.map(hook => hook.path));

	addPaths(configuredPaths.map(p => resolvePath(p, cwd)));

	return loadHooks(allPaths, cwd, adoptSpawnedPid, gateSpawn);
}

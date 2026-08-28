import type * as arktype from "arktype";
import type * as zod from "zod/v4";
import type { ExecOptions, ExecResult, HookCommandContext } from "../../extensibility/hooks/types";
import type * as PiCodingAgent from "../../index";
import type * as TypeBox from "../typebox";

export type { ExecOptions, ExecResult, HookCommandContext };

export interface CustomCommandAPI {
	cwd: string;
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	typebox: typeof TypeBox;
	arktype: typeof arktype;
	zod: typeof zod;
	pi: typeof PiCodingAgent;
}

export type BundledCommandAPI = Omit<CustomCommandAPI, "pi">;

export interface CustomCommand {
	name: string;
	description: string;
	spawnsAgents?: readonly string[];
	execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> | string | undefined;
}

export type CustomCommandFactory = (
	api: CustomCommandAPI,
) => CustomCommand | CustomCommand[] | Promise<CustomCommand | CustomCommand[]>;

export type CustomCommandSource = "bundled" | "user" | "project";

export interface LoadedCustomCommand {
	path: string;
	resolvedPath: string;
	command: CustomCommand;
	source: CustomCommandSource;
}

export interface CustomCommandsLoadResult {
	commands: LoadedCustomCommand[];
	errors: Array<{ path: string; error: string }>;
}

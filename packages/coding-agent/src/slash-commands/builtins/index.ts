import type { BuiltinSlashCommandName } from "../builtin-declarations";
import { CONTEXT_HANDLERS } from "./context";
import { INFO_HANDLERS } from "./info";
import { MODEL_HANDLERS } from "./model";
import { MODES_HANDLERS } from "./modes";
import { SESSION_HANDLERS } from "./session";
import { SETUP_HANDLERS } from "./setup";
import { SHARE_HANDLERS } from "./share";
import type { HandlerSetFor } from "./types";
import { WORKSPACE_HANDLERS } from "./workspace";

export const BUILTIN_SLASH_COMMAND_HANDLERS = {
	...SETUP_HANDLERS,
	...MODES_HANDLERS,
	...MODEL_HANDLERS,
	...SHARE_HANDLERS,
	...WORKSPACE_HANDLERS,
	...CONTEXT_HANDLERS,
	...SESSION_HANDLERS,
	...INFO_HANDLERS,
} satisfies { [Name in BuiltinSlashCommandName]: HandlerSetFor<Name> };

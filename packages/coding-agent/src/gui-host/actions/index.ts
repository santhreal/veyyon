import { agentsActionHandlers } from "./agents";
import { changesActionHandlers } from "./changes";
import { connectionActionHandlers } from "./connection";
import { diagnosticsActionHandlers } from "./diagnostics";
import { filesActionHandlers } from "./files";
import { mcpActionHandlers } from "./mcp";
import { modelsActionHandlers } from "./models";
import { processesActionHandlers } from "./processes";
import { providersActionHandlers } from "./providers";
import { sessionsActionHandlers } from "./sessions";
import { settingsActionHandlers } from "./settings";
import { terminalsActionHandlers } from "./terminals";
import { turnActionHandlers } from "./turn";
import type { ActionHandlersMap } from "./types";

export * from "./agents";
export * from "./changes";
export * from "./connection";
export * from "./diagnostics";
export * from "./files";
export * from "./mcp";
export * from "./models";
export * from "./processes";
export * from "./providers";
export * from "./sessions";
export * from "./settings";
export * from "./terminals";
export * from "./turn";
export * from "./types";

export const allActionHandlers: ActionHandlersMap = {
	...connectionActionHandlers,
	...sessionsActionHandlers,
	...turnActionHandlers,
	...filesActionHandlers,
	...changesActionHandlers,
	...terminalsActionHandlers,
	...processesActionHandlers,
	...modelsActionHandlers,
	...providersActionHandlers,
	...mcpActionHandlers,
	...agentsActionHandlers,
	...settingsActionHandlers,
	...diagnosticsActionHandlers,
};

import { agentsActionHandlers } from "./agents";
import { autoswarmActionHandlers } from "./autoswarm";
import { changesActionHandlers } from "./changes";
import { commandsActionHandlers } from "./commands";
import { connectionActionHandlers } from "./connection";
import { diagnosticsActionHandlers } from "./diagnostics";
import { dictationActionHandlers } from "./dictation";
import { filesActionHandlers } from "./files";
import { foregroundActionHandlers } from "./foreground";
import { goalActionHandlers } from "./goals";
import { historyActionHandlers } from "./history";
import { mcpActionHandlers } from "./mcp";
import { modelsActionHandlers } from "./models";
import { pauseActionHandlers } from "./pause";
import { planReviewActionHandlers } from "./plan-review";
import { processesActionHandlers } from "./processes";
import { profileActionHandlers } from "./profiles";
import { providersActionHandlers } from "./providers";
import { sessionsActionHandlers } from "./sessions";
import { settingsActionHandlers } from "./settings";
import { shareActionHandlers } from "./share";
import { terminalsActionHandlers } from "./terminals";
import { turnActionHandlers } from "./turn";
import type { ActionHandlersMap } from "./types";

export * from "./agents";
export * from "./autoswarm";
export * from "./changes";
export * from "./commands";
export * from "./connection";
export * from "./diagnostics";
export * from "./dictation";
export * from "./files";
export * from "./foreground";
export * from "./goals";
export * from "./history";
export * from "./mcp";
export * from "./models";
export * from "./pause";
export * from "./plan-review";
export * from "./processes";
export * from "./profiles";
export * from "./providers";
export * from "./sessions";
export * from "./settings";
export * from "./share";
export * from "./terminals";
export * from "./turn";
export * from "./types";

export const allActionHandlers: ActionHandlersMap = {
	...connectionActionHandlers,
	...pauseActionHandlers,
	...sessionsActionHandlers,
	...historyActionHandlers,
	...turnActionHandlers,
	...foregroundActionHandlers,
	...filesActionHandlers,
	...changesActionHandlers,
	...goalActionHandlers,
	...terminalsActionHandlers,
	...processesActionHandlers,
	...modelsActionHandlers,
	...providersActionHandlers,
	...mcpActionHandlers,
	...agentsActionHandlers,
	...commandsActionHandlers,
	...settingsActionHandlers,
	...shareActionHandlers,
	...profileActionHandlers,
	...planReviewActionHandlers,
	...diagnosticsActionHandlers,
	...dictationActionHandlers,
	...autoswarmActionHandlers,
};

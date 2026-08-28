import { CHANGELOG_URL } from "@veyyon/utils";
import { commandConsumed } from "../helpers/parse";
import type { HandlerSetFor } from "./types";

export const INFO_HANDLERS = {
	changelog: {
		handle: async (_command, runtime) => {
			await runtime.output(`Release notes: ${CHANGELOG_URL}`);
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleChangelogCommand();
			runtime.ctx.editor.setText("");
		},
	},
	hotkeys: {
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	debug: {
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	omfg: {
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
} satisfies {
	changelog: HandlerSetFor<"changelog">;
	hotkeys: HandlerSetFor<"hotkeys">;
	debug: HandlerSetFor<"debug">;
	omfg: HandlerSetFor<"omfg">;
};

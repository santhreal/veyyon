/**
 * What a command printed, drawn where the terminal draws it: in the
 * conversation, under the command that produced it.
 *
 * The entry is sent and not recorded. A command's output is what the terminal
 * writes to its status line, so it is neither part of the session file nor of
 * the context the next turn is built from; reloading the transcript drops it,
 * exactly as leaving the terminal screen does.
 */

import type { ActionContext } from "./actions/types";
import { writeFrame } from "./frames";
import type { TranscriptEntry } from "./wire";

export function appendCommandOutput(ctx: ActionContext, command: string, text: string): void {
	ctx.clientState.revision += 1;
	const entry: TranscriptEntry = {
		id: `command-output-${ctx.clientState.revision}`,
		parent: null,
		revision: ctx.clientState.revision,
		timestamp_ms: Date.now(),
		role: "Custom",
		content: [{ Text: { text } }],
		meta: null,
		raw_discriminator: "command_output",
		raw: { command, text },
	};
	writeFrame(ctx.socket, {
		TranscriptAppended: { revision: ctx.clientState.revision, entries: [entry] },
	});
}

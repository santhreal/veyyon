/**
 * Print the transcript blocks that own a turn, one under another, at one width.
 *
 * `render-transcript-rail.ts` answers the rail question for a tool call and a
 * bash run. This one answers it for the blocks a COMMAND makes: `/btw`, `/omfg`,
 * a command's own answer, the pinned error banner, the tiny-model download, and
 * the cut-short batch marker. Each of them used to draw a full-width rule above
 * and below itself and start a column left of the prose, so the transcript read
 * as a stack of boxes rather than one column.
 *
 * Every block is a REAL component driven through its own public API, so the
 * image answers what ships. Pipe into `render-proof.ts` for the pair:
 *
 * Run:
 *
 *     bun scripts/demos/render-transcript-blocks.ts --width 100 --ruler |
 *       bun scripts/demos/render-proof.ts --out /tmp/blocks --width 100
 *
 * `--ruler` prefixes a column ruler so a block's start column is read off the
 * image instead of estimated.
 */

import type { AgentMessage } from "../../packages/agent/src/index";
import { BtwPanelComponent } from "../../packages/coding-agent/src/modes/components/btw-panel";
import {
	COMPOSER_INSET_COLS,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/components/composer-chrome";
import { ErrorBannerComponent } from "../../packages/coding-agent/src/modes/components/error-banner";
import { OmfgPanelComponent } from "../../packages/coding-agent/src/modes/components/omfg-panel";
import { TinyTitleDownloadProgressComponent } from "../../packages/coding-agent/src/modes/components/tiny-title-download-progress";
import { showCommandMessage } from "../../packages/coding-agent/src/modes/controllers/command-controller-shared";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { InteractiveModeContext } from "../../packages/coding-agent/src/modes/types";
import { UiHelpers } from "../../packages/coding-agent/src/modes/utils/ui-helpers";
import { type Component, Container, type TUI } from "../../packages/tui/src/index";
import { flag, hasFlag, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initTheme(false, "unicode", false, themeName, themeName);

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const lines: string[] = [];

if (hasFlag("ruler")) {
	let tens = "";
	let units = "";
	for (let col = 0; col < width; col++) {
		tens += col % 10 === 0 ? String(Math.floor(col / 10) % 10) : " ";
		units += String(col % 10);
	}
	lines.push(theme.fg("dim", tens), theme.fg("dim", units));
}

function push(block: Component): void {
	lines.push(...block.render(width), "");
}

const accents = resolveComposerAccents({
	bypass: false,
	bashMode: false,
	pythonMode: false,
	planMode: false,
	focusedSubagent: false,
	sessionAccentAnsi: undefined,
	thinkingLevel: "off",
});

// A user turn and a paragraph of prose: the edge every block below is measured against.
lines.push(`${accents.promptGutter}why does the run abort?`, "");
lines.push(`${" ".repeat(COMPOSER_INSET_COLS)}The parser rejects an empty focus string, so the run aborts.`, "");

const btw = new BtwPanelComponent({ question: "what is a focus string?", tui: ui });
btw.setAnswer("A **focus string** names the tests a run executes.");
btw.markComplete();
push(btw);

const omfg = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: ui });
omfg.setRule("## Imports\n\nNever reorder an untouched import block.");
omfg.setStatus("confirming", "Save this rule? y/n");
push(omfg);

const presented: Component[] = [];
showCommandMessage({ present: (block: Component) => presented.push(block) }, "Server added: local-fs");
const commandBlock = presented[0];
if (commandBlock) push(commandBlock);

const tiny = new TinyTitleDownloadProgressComponent("lfm2-700m");
tiny.update({
	modelKey: "lfm2-700m",
	status: "progress_total",
	progress: 50,
	loaded: 50_000_000,
	total: 100_000_000,
	files: { "onnx/model_q4.onnx": { loaded: 50_000_000, total: 100_000_000 } },
});
push(tiny);

// The cut-short batch ledger, through the live transcript path that receives it:
// a synthetic user message carrying the model-facing ledger text.
const ledgerContainer = new Container();
const helpers = new UiHelpers({
	chatContainer: ledgerContainer,
	getUserMessageText: (message: AgentMessage) =>
		message.role === "user" && typeof message.content === "string" ? message.content : "",
	viewSession: { sessionManager: { putBlobSync: () => "blob://unused" } },
	editor: { addToHistory: () => {} },
	ui,
} as unknown as InteractiveModeContext);
helpers.addMessageToChat({
	role: "user",
	synthetic: true,
	timestamp: 1,
	content: [
		"Partial completion ledger for this tool batch (2 calls): 1 ran, 1 never ran.",
		"Cause: the turn was aborted before the remaining calls were dispatched.",
		"- never ran, arguments never finished: tool_lqkR2mNN5n7yrjUqtWSj4yaj (bash)",
		'Only the calls marked "never ran" need retrying; they had no side effects.',
	].join("\n"),
});
push(ledgerContainer);

push(new ErrorBannerComponent("Output blocked by content filtering policy"));

// The composer's gutter last, because it is the rail everything above is measured against.
lines.push(`${accents.promptGutter}`);

process.stdout.write(`${lines.join("\n")}\n`);

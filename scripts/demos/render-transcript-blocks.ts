/**
 * Render transcript component blocks including panels, download bars, and error banners.
 *
 * Assembles sample transcript elements such as composer prompt gutters, user chat messages,
 * question-and-answer panels, rule confirmation dialogs, command messages, model download
 * progress bars, tool execution ledgers, and error banners. Prints the combined transcript
 * layout as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-transcript-blocks.ts [--ruler] [--width 100] [--theme titanium]
 */

import { type Component, Container } from "../../hosts/terminal/engine/src/index";
import type { AgentMessage } from "../../packages/agent/src/index";
import { TinyTitleDownloadProgressComponent } from "../../packages/coding-agent/src/modes/terminal/components/chrome/tiny-title-download-progress";
import {
	COMPOSER_INSET_COLS,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/terminal/components/composer/composer-chrome";
import { BtwPanelComponent } from "../../packages/coding-agent/src/modes/terminal/components/dialogs/btw-panel";
import { OmfgPanelComponent } from "../../packages/coding-agent/src/modes/terminal/components/dialogs/omfg-panel";
import { ErrorBannerComponent } from "../../packages/coding-agent/src/modes/terminal/components/transcript/error-banner";
import { showCommandMessage } from "../../packages/coding-agent/src/modes/terminal/controllers/command-controller-shared";
import type { InteractiveModeContext } from "../../packages/coding-agent/src/modes/terminal/types";
import { UiHelpers } from "../../packages/coding-agent/src/modes/terminal/utils/ui-helpers";
import { mockTui, renderDemo, renderRuler } from "./render-args";

await renderDemo(({ width, hasFlag }) => {
	const ui = mockTui();
	const lines: string[] = [];

	if (hasFlag("ruler")) {
		lines.push(...renderRuler(width));
	}

	function push(block: Component): void {
		lines.push(...block.render(width), "");
	}

	const accents = resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE);

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
	if (presented[0]) push(presented[0]);

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
	lines.push(`${accents.promptGutter}`);
	return lines;
});

import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@veyyon/tui";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { getMarkdownTheme } from "../theme/markdown-theme";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { mountTranscriptBlock } from "./transcript-block-chrome";

export type OmfgPanelState =
	| "generating"
	| "validating"
	| "confirming"
	| "saving"
	| "saved"
	| "rejected"
	| "aborted"
	| "error";

interface OmfgPanelComponentOptions {
	complaint: string;
	tui: TUI;
}

export class OmfgPanelComponent extends Container {
	#complaint: string;
	#tui: TUI;
	#state: OmfgPanelState = "generating";
	#status = "Generating TTSR rule…";
	#preview = "";
	#savedPath: string | undefined;
	#errorMessage: string | undefined;
	#closed = false;

	constructor(options: OmfgPanelComponentOptions) {
		super();
		this.#complaint = options.complaint;
		this.#tui = options.tui;
		this.#rebuild();
	}

	appendDraft(delta: string): void {
		if (!delta || this.#closed) return;
		this.#preview += delta;
		this.#rebuild();
	}

	setRule(text: string): void {
		if (this.#closed) return;
		this.#preview = text;
		this.#rebuild();
	}

	setStatus(state: OmfgPanelState, status: string): void {
		if (this.#closed) return;
		this.#state = state;
		this.#status = status;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markSaved(path: string): void {
		if (this.#closed) return;
		this.#state = "saved";
		this.#savedPath = path;
		this.#status = `Saved ${path}`;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markRejected(): void {
		if (this.#closed) return;
		this.#state = "rejected";
		this.#status = "Rule was not saved.";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#status = "Cancelled.";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#status = "Could not create rule.";
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		mountTranscriptBlock(this, {
			header: theme.bold(
				theme.fg("accent", truncateToWidth(replaceTabs(`/omfg ${this.#complaint}`), TRUNCATE_LENGTHS.LINE)),
			),
			subheader: theme.fg(
				"muted",
				replaceTabs(truncateToWidth(shortenEmbeddedPaths(this.#status), TRUNCATE_LENGTHS.LINE)),
			),
			body: this.#contentComponent(),
			footer: this.#footerLine(),
		});
		this.#tui.requestRender();
	}

	#footerLine(): string {
		switch (this.#state) {
			case "generating":
			case "validating":
			case "confirming":
			case "saving":
				return theme.fg("muted", "esc cancel /omfg");
			case "saved":
				return theme.fg(
					"success",
					`${theme.status.success} Registered live · ${replaceTabs(truncateToWidth(shortenPath(this.#savedPath ?? "saved"), TRUNCATE_LENGTHS.TITLE))} · esc dismiss`,
				);
			case "rejected":
				return theme.fg("warning", `${theme.status.warning} Not saved · esc dismiss`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · esc dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(
				theme.fg("error", replaceTabs(shortenEmbeddedPaths(this.#errorMessage ?? "Unknown error"))),
				COMPOSER_INSET_COLS,
				0,
			);
		}
		const text = replaceTabs(this.#preview).trim();
		if (!text) {
			return new Text(
				theme.fg("dim", `${theme.status.pending} Waiting for candidate rule…`),
				COMPOSER_INSET_COLS,
				0,
			);
		}
		const preview = new Markdown(text, COMPOSER_INSET_COLS, 0, getMarkdownTheme());
		if (this.#state !== "saved") {
			return preview;
		}
		const block = new Container();
		block.addChild(preview);
		block.addChild(new Spacer(1));
		block.addChild(
			new Text(
				theme.fg("dim", "TTSR rule created — manage it under User created in Settings → Stream Interrupts (TTSR)."),
				COMPOSER_INSET_COLS,
				0,
			),
		);
		return block;
	}
}

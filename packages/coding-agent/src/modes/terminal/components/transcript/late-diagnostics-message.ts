import { Container, Text } from "@veyyon/tui";
import type { LateDiagnosticsFileDisplay } from "@veyyon/wire/presentation";
import { theme } from "../../../../theme/theme";
import { diagnosticsSection } from "../../../../tools/core/diagnostics";
import { drawHiddenNote, drawSpans } from "../../draw/draw-tool-view";

/** One file's worth of late LSP diagnostics, as carried on the transcript message. */
export interface LateDiagnosticsFile extends LateDiagnosticsFileDisplay {}

/**
 * Renders late LSP diagnostics with the same diagnostic section and span drawing
 * as edit/write cards. Supports the global tool-output expand toggle.
 */
export class LateDiagnosticsMessageComponent extends Container {
	#expanded = false;

	constructor(private readonly files: readonly LateDiagnosticsFileDisplay[]) {
		super();
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();

		const messages: string[] = [];
		const summaries: string[] = [];
		let errored = false;
		for (const file of this.files) {
			if (file.messages?.length) messages.push(...file.messages);
			if (file.summary) summaries.push(file.summary);
			if (file.errored) errored = true;
		}
		const section = diagnosticsSection({ errored, summary: summaries.join(", "), messages }, this.#expanded, {
			title: "Late diagnostics",
		});
		if (section === undefined) return;
		const lines = section.lines.map(line => drawSpans(line, theme));
		const hidden = section.hidden === undefined ? undefined : drawHiddenNote(section.hidden, theme);
		if (hidden !== undefined) lines.push(hidden);
		this.addChild(new Text(lines.join("\n"), 1, 0));
	}
}

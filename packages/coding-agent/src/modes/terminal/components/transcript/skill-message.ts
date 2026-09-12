import type { Component } from "@veyyon/tui";
import { Box, Container, Markdown, Spacer, Text } from "@veyyon/tui";
import { collapseWhitespace } from "@veyyon/utils";
import type { SkillPromptCustomDisplay } from "@veyyon/wire/presentation";
import { withIcon } from "../../../../theme/icon-label";
import { getMarkdownTheme } from "../../../../theme/markdown-theme";
import { theme } from "../../../../theme/theme";
import { shortenPath } from "../../../../tools/core/render-utils";
import { fileHyperlink } from "../../draw/hyperlink";
import { cardOutlineColor } from "./message-frame";

export class SkillMessageComponent extends Container {
	#box: Box;
	#contentComponent?: Component;
	#expanded = false;

	constructor(private readonly message: SkillPromptCustomDisplay) {
		super();

		this.#box = new Box(1, 1);
		this.#box.setIgnoreTight(true);
		this.#rebuild();
	}
	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#contentComponent) {
			this.removeChild(this.#contentComponent);
			this.#contentComponent = undefined;
		}

		this.removeChild(this.#box);
		this.addChild(this.#box);
		this.#box.clear();
		// Re-read symbols every rebuild so a runtime theme/preset switch refreshes the outline.
		this.#box.setBorder({ chars: theme.boxSharp, color: cardOutlineColor() });
		// A card hugs its content; a frame stretched to the terminal edge reads
		// as a wall (defect: boxes always full width regardless of content).
		this.#box.setHugContent(true);

		const name = this.message.name;
		const rawArgs = this.message.args;
		// Collapse args to one line: a stray newline/tab in user-supplied args would split the header.
		const args = collapseWhitespace(rawArgs);

		// Header: icon-tag + skill name, with the invocation args trailing dimmed.
		const tag = theme.fg("customMessageLabel", theme.bold(withIcon(theme.icon.extensionSkill, "skill")));
		let header = `${tag} ${theme.fg("customMessageText", theme.bold(name))}`;
		if (args) {
			header += ` ${theme.fg("dim", args)}`;
		}
		this.#box.addChild(new Text(header, 0, 0));

		const meta = this.#metaLine();
		if (meta) {
			this.#box.addChild(new Text(meta, 0, 0));
		}
		if (!this.#expanded) {
			return;
		}

		const text = this.message.text;
		if (!text) {
			return;
		}

		this.#box.addChild(new Spacer(1));
		this.#box.addChild(new Text(theme.fg("muted", "prompt"), 0, 0));
		this.#box.addChild(new Spacer(1));

		this.#contentComponent = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		});
		this.#box.addChild(this.#contentComponent);
	}

	/** Sub-line under the header: home-shortened (clickable) accent path · muted prompt size. */
	#metaLine(): string | undefined {
		const parts: string[] = [];

		const filePath = this.message.path;
		if (filePath) {
			parts.push(fileHyperlink(filePath, theme.fg("accent", shortenPath(filePath)), { line: 1 }));
		}
		const lineCount = this.message.lineCount;
		if (typeof lineCount === "number") {
			parts.push(theme.fg("muted", `${lineCount} ${lineCount === 1 ? "line" : "lines"}`));
		}

		if (parts.length === 0) {
			return undefined;
		}
		return `  ${parts.join(theme.fg("muted", theme.sep.dot))}`;
	}
}

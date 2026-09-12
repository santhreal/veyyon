/**
 * Render transcript todo reminders and rule notification cards.
 *
 * Constructs todo reminder components and single or multi-rule notification components.
 * Sets terminal ground tints and renders note components either as standard transcript
 * cards or as highlighted warning slabs, printing the output as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-todo-reminder.ts [--slab] [--flat] [--ground #rrggbb] [--width 100] [--theme titanium]
 */

import { Box, Spacer, Text } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import type { Rule } from "../../packages/coding-agent/src/discovery/capability/rule";
import { createSourceMeta } from "../../packages/coding-agent/src/discovery/helpers";
import { TodoReminderComponent } from "../../packages/coding-agent/src/modes/terminal/components/dashboard/todo-reminder";
import type { TranscriptNote } from "../../packages/coding-agent/src/modes/terminal/components/transcript/transcript-note";
import { TtsrNotificationComponent } from "../../packages/coding-agent/src/modes/terminal/components/transcript/ttsr-notification";
import { setDetectedTerminalGround } from "../../packages/coding-agent/src/theme/ground-tints";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import type { TodoItem } from "../../packages/coding-agent/src/tools/agent/todo";
import { GREY_GROUND } from "./lib/ansi-raster";
import { renderDemo } from "./render-args";

await renderDemo(
	({ width, flag, hasFlag }) => {
		const groundHex = flag("ground", `#${GREY_GROUND.background.map(c => c.toString(16).padStart(2, "0")).join("")}`);
		if (!hasFlag("flat")) setDetectedTerminalGround(groundHex);

		const todos: TodoItem[] = Array.from({ length: 12 }, (_, index) => ({
			content:
				index === 11
					? "Run the focused reminder and compaction suites"
					: `Pending implementation item ${index + 1}`,
			status: index === 11 ? "in_progress" : "pending",
		}));

		const rule = (name: string, description: string): Rule => ({
			name,
			path: `builtin-defaults:core/${name}.md`,
			content: description,
			description,
			_source: createSourceMeta("builtin-defaults", `builtin-defaults:core/${name}.md`, "user"),
		});

		const notes = [
			new TodoReminderComponent(todos, 1, 3),
			new TtsrNotificationComponent([
				rule("commit-drift", "A green chunk is a commit. Stage the paths you touched and commit them."),
			]),
			new TtsrNotificationComponent([
				rule("commit-drift", "A green chunk is a commit."),
				rule("test-scope", "Run the narrowest suite that covers the change."),
				rule("gate-once", "A gate confirms, it never informs."),
			]),
		];

		function renderSlab(note: TranscriptNote): string[] {
			const box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
			box.setIgnoreTight(true);
			box.addChild(new Text(note.headline, 0, 0));
			if (note.rows.length > 0) {
				box.addChild(new Spacer(1));
				box.addChild(new Text(note.rows.map(row => stripAnsi(row)).join("\n"), 0, 0));
			}
			return ["", ...box.render(width), ""];
		}

		return hasFlag("slab") ? notes.flatMap(note => renderSlab(note.note)) : notes.flatMap(note => note.render(width));
	},
	{ settings: true },
);

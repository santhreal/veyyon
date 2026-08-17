/**
 * Every note the session commits into the transcript, at one width: the todo
 * reminder with a list long enough to clip, one injected rule, and several.
 *
 * The reminder is not a list view: it shows the in-progress item and a count,
 * and the interesting question is what it does when the list is longer than the
 * room it has. Twelve items with the in-progress one at the end is the case
 * that exercises both, and reading the component cannot answer it because the
 * clipping happens at render width.
 *
 * Run:
 *
 *     bun scripts/demos/render-todo-reminder.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/notes --width 100
 *
 * `--theme <name>` renders another theme; the default is titanium.
 *
 * `--flat` withholds the ground, which is the OFF arm of the note's material: with
 * no known ground the note takes no surface and is the rail and the colours alone,
 * which is also what a terminal that never answered OSC 11 gets. In a real session
 * the value arrives from that answer, and a headless script would otherwise fall
 * back to the theme's DECLARED ground — black for titanium — and film a black slab
 * sitting on a grey page.
 *
 * `--slab` is the OFF arm of the whole treatment: the same notes drawn through the
 * chrome they used to have, a full-width inverted warning box. Take the pair to see
 * what changed rather than one frame of what is there now.
 */
import { Box, Spacer, Text } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import type { Rule } from "../../packages/coding-agent/src/capability/rule";
import { createSourceMeta } from "../../packages/coding-agent/src/discovery/helpers";
import { TodoReminderComponent } from "../../packages/coding-agent/src/modes/components/todo-reminder";
import type { TranscriptNote } from "../../packages/coding-agent/src/modes/components/transcript-note";
import { TtsrNotificationComponent } from "../../packages/coding-agent/src/modes/components/ttsr-notification";
import { setDetectedTerminalGround } from "../../packages/coding-agent/src/modes/theme/ground-tints";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { TodoItem } from "../../packages/coding-agent/src/tools/todo";
import { GREY_GROUND } from "./lib/ansi-raster";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const groundHex = flag("ground", `#${GREY_GROUND.background.map(c => c.toString(16).padStart(2, "0")).join("")}`);
await initRender(themeName, { settings: true });
if (!hasFlag("flat")) setDetectedTerminalGround(groundHex);

const todos: TodoItem[] = Array.from({ length: 12 }, (_, index) => ({
	content:
		index === 11 ? "Run the focused reminder and compaction suites" : `Pending implementation item ${index + 1}`,
	status: index === 11 ? "in_progress" : "pending",
}));

/** A bundled rule as the loader hands one over, so the note gets the real shape. */
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

/**
 * The chrome the notes used to have: a `Box` whose background function inverts the
 * warning colour, padding every row out to the terminal width. Rendered from the
 * note the component itself is carrying, so the OFF arm of the pair differs from the
 * ON arm in the chrome and in nothing else.
 */
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

const lines = hasFlag("slab")
	? notes.flatMap(note => renderSlab(note.note))
	: notes.flatMap(note => note.render(width));
process.stdout.write(`${lines.join("\n")}\n`);

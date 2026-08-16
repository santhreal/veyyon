/**
 * Print every divider the transcript can draw, one under another.
 *
 * A divider marks a point in the conversation: a compaction, a handoff, a
 * branch collapsing back, a prompt cache that went cold. The question the image
 * answers is what the mark does to the page — a rule padded out to the viewport
 * cuts the transcript in half, a short mark on the left edge does not — so the
 * proof stacks the real components between two lines of ordinary transcript at
 * the shared inset, which is the only place the difference is visible.
 *
 *     bun scripts/demos/render-transcript-dividers.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/dividers --width 100
 *
 * Each block is a REAL component built from a real message, not a mock-up of
 * one. `--expanded` opens the detail every summary divider hides behind ctrl+o.
 */
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../packages/agent/src/compaction/messages";
import { KEYBINDINGS } from "../../packages/coding-agent/src/config/keybindings";
import { CacheInvalidationMarkerComponent } from "../../packages/coding-agent/src/modes/components/cache-invalidation-marker";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	HandoffSummaryMessageComponent,
} from "../../packages/coding-agent/src/modes/components/compaction-summary-message";
import { COMPOSER_INSET_COLS } from "../../packages/coding-agent/src/modes/components/composer-chrome";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { KeybindingsManager, setKeybindings } from "../../packages/tui/src/keybindings";
import { flag, hasFlag, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const expanded = hasFlag("expanded");
await initTheme(false, "unicode", false, themeName, themeName);
// The expand hint on a summary divider is read from the live keybindings.
setKeybindings(new KeybindingsManager(KEYBINDINGS));

const now = new Date().toISOString();
const inset = " ".repeat(COMPOSER_INSET_COLS);
const lines: string[] = [];

const prose = (text: string) => {
	lines.push(`${inset}${text}`);
};

const divider = (component: { setExpanded?(value: boolean): void; render(width: number): readonly string[] }) => {
	component.setExpanded?.(expanded);
	lines.push(...component.render(width));
};

prose("The parser rejects an empty focus string, so the run aborts.");
divider(
	new CompactionSummaryMessageComponent(
		createCompactionSummaryMessage("Earlier the login TTL bug was fixed.", 84_000, now),
	),
);
prose("Picking up from the summary: the TTL fix is in place.");
divider(
	new HandoffSummaryMessageComponent(
		createCustomMessage(
			"handoff",
			"<handoff-context>\nCarry the TTL fix forward.\n</handoff-context>",
			true,
			undefined,
			now,
		),
	),
);
prose("The side branch is folded back into the main line.");
divider(
	new BranchSummaryMessageComponent(createBranchSummaryMessage("The parser fix landed on the branch.", "b1", now)),
);
prose("The next turn reprocessed its whole prompt.");
divider(new CacheInvalidationMarkerComponent({ reprocessedTokens: 50_999, cause: "cwd-change" }));
prose("Back to ordinary transcript prose on the shared inset.");

process.stdout.write(`${lines.join("\n")}\n`);

/**
 * Print a real selector's card as ANSI, for the selection-band render proofs.
 *
 * A band that stops mid-row is invisible to a test that renders with colour off,
 * and colour off is what a test gets by default: the fill is simply not there
 * either way. It is also invisible in a terminal capture on a black ground,
 * because a dark tint on black looks like no tint at all. So the way this class
 * of defect gets SEEN is a real render, rasterized on both a grey ground and a
 * black one, and looked at.
 *
 * The component is the shipped one, driven through its own `render`, so what the
 * proof shows is what the surface draws. The rows are deliberately uneven: even
 * width hides the defect completely, since a band sized to the text and a band
 * sized to the row are the same picture when every row is the same length.
 *
 * Usage:
 *
 *     bun scripts/demos/render-selection-bands.ts --rows 34
 *       | bun scripts/demos/render-proof.ts --out /tmp/proof/band-history --width 110
 */

import { HistorySearchComponent } from "../../packages/coding-agent/src/modes/components/history-search";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { HistoryEntry, HistoryStorage } from "../../packages/coding-agent/src/session/history-storage";
import { setAnsiPolicy } from "../../packages/tui/src/index";
import { flag, renderWidth } from "./render-args";

const width = renderWidth();
const themeName = flag("theme", "titanium");
const ROWS = Number.parseInt(flag("rows", "34"), 10);
/** Which result the cursor sits on, so a proof can show a short row banded. */
const SELECTED = Number.parseInt(flag("selected", "1"), 10);

await initTheme(false, "unicode", false, themeName, themeName);
// The proof is ABOUT the fill, so the policy that decides whether a fill is
// emitted at all cannot be left to whatever a pipe reports.
setAnsiPolicy("full");

// Fixed geometry: the card sizes itself from the live terminal, and a proof that
// changes shape with the window it was generated in cannot be compared.
Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => ROWS });
Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => width });

/** Prompts of very uneven length, which is what makes a ragged band visible. */
const PROMPTS = [
	"fix it",
	"walk the whole roster and tell me which agents are still holding a session open after their task finished",
	"why is the modal shorter",
	"x",
	"rewrite the session loader so a malformed record costs its own row instead of the whole transcript",
	"ls",
	"add a page up and page down binding to the control center, same distance as every other selector",
	"what changed",
];

const NOW = Math.floor(Date.parse("2026-07-27T12:00:00.000Z") / 1000);

function entries(): HistoryEntry[] {
	return PROMPTS.map((prompt, index) => ({
		id: index + 1,
		prompt,
		cwd: "/repo",
		sessionId: "s-1",
		created_at: NOW - index * 900,
	}));
}

const storage = {
	getRecent: () => entries(),
	search: () => entries(),
} as unknown as HistoryStorage;

const card = new HistorySearchComponent(
	storage,
	() => {},
	() => {},
);
// Walk the cursor down rather than reaching into the component: the selection
// index is private, and driving the keys is what a user does anyway.
for (let step = 0; step < SELECTED; step++) card.handleInput("\x1b[B");

process.stdout.write(`${card.render(width).join("\n")}\n`);

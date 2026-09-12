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

import type { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { HistorySearchComponent } from "../../packages/coding-agent/src/modes/terminal/components/composer/history-search";
import { renderDemo } from "./render-args";

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

const storage = {
	getRecent: () =>
		PROMPTS.map((prompt, index) => ({
			id: index + 1,
			prompt,
			cwd: "/repo",
			sessionId: "s-1",
			created_at: NOW - index * 900,
		})),
	search: () =>
		PROMPTS.map((prompt, index) => ({
			id: index + 1,
			prompt,
			cwd: "/repo",
			sessionId: "s-1",
			created_at: NOW - index * 900,
		})),
} as unknown as HistoryStorage;

await renderDemo(
	({ width, flag }) => {
		const card = new HistorySearchComponent(
			storage,
			() => {},
			() => {},
		);
		const selected = Number.parseInt(flag("selected", "1"), 10);
		for (let step = 0; step < selected; step++) card.handleInput("\x1b[B");
		return card.render(width);
	},
	{ defaultHeight: 34 },
);

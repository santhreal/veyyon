/**
 * The effort step wraps a long description instead of clipping it.
 *
 * WHY THIS SUITE EXISTS. The `auto` row's whole point is the list of levels it
 * chooses between — "Choose per prompt from minimal, low, medium, high" — and
 * at settings-picker width the single-line layout clipped exactly the last
 * level off behind an ellipsis. The row now wraps onto a continuation line
 * indented under the description column, so every level the model declares is
 * visible.
 *
 * What this does not catch: very narrow terminals, where even the wrapped form
 * scrolls — the information is then reachable by scrolling, not gone.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBundledModel } from "@veyyon/catalog/models";
import { renderEffortStep } from "@veyyon/coding-agent/modes/components/effort-picker";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { Container } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme();
});

describe("the effort step wraps instead of clipping", () => {
	test("every declared level is visible at picker width", () => {
		const model = getBundledModel("azure", "gpt-5");
		const container = new Container();
		renderEffortStep(
			container,
			"azure/gpt-5",
			model,
			() => {},
			() => {},
		);

		const text = container.render(60).map(stripVTControlCharacters).join("\n");
		// The wrapped form breaks after "medium," and indents "high" under the
		// description column; the clipped form ended the row at "medium, …" and
		// "high" appeared only as its own row's label, never in `auto`'s list.
		expect(text).toMatch(/medium,\s*\n\s+high/);
		expect(text).not.toContain("Choose per prompt from …");
	});
});

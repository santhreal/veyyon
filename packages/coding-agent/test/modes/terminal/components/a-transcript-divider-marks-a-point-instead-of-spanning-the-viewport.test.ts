/**
 * Every divider in the transcript is a short mark on the left edge, never a
 * rule spanning the viewport.
 *
 * WHY: the transcript carries ONE left rail, and a full-bleed horizontal
 * competes with it — a compaction point read as a page break shouting over the
 * two lines it separated. The compaction, handoff and branch dividers each
 * centered a label inside a rule padded out to the full width; the cache-miss
 * marker, written later, used the short left rule. Two shapes for one idea.
 *
 * The class this closes: a transcript divider that spans the viewport, and a
 * NEW divider added in either shape. The sweep enumerates the divider
 * components exported by the two modules that own them at run time and pins the
 * covered set by exact equality, so adding a divider without a fixture turns
 * this suite red rather than letting a second house style back in.
 *
 * Not caught: where a divider is MOUNTED. A component that draws the right row
 * can still be added to the wrong container, or indented by its parent; this
 * suite reads the rows a divider returns, not the frame the transcript composes
 * from them.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@veyyon/agent-core/compaction/messages";
import { KEYBINDINGS } from "@veyyon/coding-agent/config/keybindings";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import * as cacheMarkerModule from "@veyyon/coding-agent/modes/terminal/components/transcript/cache-invalidation-marker";
import * as compactionModule from "@veyyon/coding-agent/modes/terminal/components/transcript/summary-message";
import { TRANSCRIPT_DIVIDER_RULE_WIDTH } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-divider";
import {
	toBranchSummaryView,
	toCompactionSummaryView,
	toHandoffSummaryView,
} from "@veyyon/coding-agent/presentation/summary-builder";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { Component } from "@veyyon/tui";
import { KeybindingsManager, setKeybindings } from "@veyyon/utils/keybindings";
import type { SummaryMessageView } from "@veyyon/wire/presentation";

const WIDTH = 80;

beforeAll(async () => {
	await initTheme();
	// The expand hint is read from the live keybindings; a divider with no hint
	// would still pass the shape assertions for the wrong reason.
	setKeybindings(new KeybindingsManager(KEYBINDINGS));
});

const SUMMARY_FIXTURES: Record<SummaryMessageView["kind"], () => Component> = {
	"compaction-summary": () =>
		new compactionModule.SummaryMessageComponent(
			toCompactionSummaryView(
				createCompactionSummaryMessage("Compaction summary.", 84_000, new Date().toISOString()),
			),
		),
	"handoff-summary": () =>
		new compactionModule.SummaryMessageComponent(
			toHandoffSummaryView(
				createCustomMessage(
					"handoff",
					"<handoff-context>\nHandoff summary.\n</handoff-context>",
					true,
					undefined,
					new Date().toISOString(),
				),
			)!,
		),
	"branch-summary": () =>
		new compactionModule.SummaryMessageComponent(
			toBranchSummaryView(createBranchSummaryMessage("Branch summary.", "branch-1", new Date().toISOString())),
		),
};

/** Every exported divider and every summary variant takes the same shape checks. */
const FIXTURES = {
	SummaryMessageComponent: SUMMARY_FIXTURES,
	CacheInvalidationMarkerComponent: {
		cache: () => new cacheMarkerModule.CacheInvalidationMarkerComponent({ reprocessedTokens: 50_999 }),
	},
};

/**
 * Names of the exported classes that render a divider, read from the modules
 * themselves. A class is one whose prototype answers `render`, which is the
 * only thing the transcript asks of it.
 */
function exportedDividerComponents(): string[] {
	const found: string[] = [];
	for (const module of [compactionModule, cacheMarkerModule]) {
		for (const [name, value] of Object.entries(module)) {
			if (typeof value !== "function") continue;
			const prototype = (value as { prototype?: Record<string, unknown> }).prototype;
			if (prototype && typeof prototype.render === "function") found.push(name);
		}
	}
	return found.sort();
}

/** The one non-blank row a collapsed divider renders. */
function dividerRow(component: Component, width: number): string {
	const rows = component.render(width).filter(row => row.trim().length > 0);
	expect(rows).toHaveLength(1);
	return Bun.stripANSI(rows[0] ?? "");
}

describe("a transcript divider", () => {
	it("covers every divider component the two modules export", () => {
		expect(exportedDividerComponents()).toEqual(Object.keys(FIXTURES).sort());
	});

	it("covers every summary kind declared by the display contract", () => {
		const source = readFileSync(
			new URL("../../../../../../contracts/wire/src/presentation/summary.ts", import.meta.url),
			"utf8",
		);
		const kinds = [...source.matchAll(/\bkind:\s*"([^"]+)"/g)].map(match => match[1]!).sort();
		expect(Object.keys(SUMMARY_FIXTURES).sort()).toEqual(kinds);
	});

	for (const [componentName, variants] of Object.entries(FIXTURES)) {
		for (const [kind, make] of Object.entries(variants)) {
			describe(`${componentName}/${kind}`, () => {
				it("starts on the transcript's rail", () => {
					const row = dividerRow(make(), WIDTH);
					// Every other transcript block opens at the composer gutter. A divider
					// only sat at column zero while it spanned the viewport.
					expect(row.slice(0, COMPOSER_INSET_COLS)).toBe(" ".repeat(COMPOSER_INSET_COLS));
					expect(row[COMPOSER_INSET_COLS]).not.toBe(" ");
				});

				it("opens with a short rule and stops at its label", () => {
					const row = dividerRow(make(), WIDTH).slice(COMPOSER_INSET_COLS);
					const rule = theme.tree.horizontal;
					const leading = row.length - row.replace(new RegExp(`^${rule}+`), "").length;

					expect(leading).toBe(TRANSCRIPT_DIVIDER_RULE_WIDTH);
					// Pinned against the constant AND against an absolute ceiling: reading
					// only the constant would follow it up to any width and call a rule
					// spanning half the viewport a mark.
					expect(leading).toBeLessThanOrEqual(12);
					expect(row[leading]).toBe(" ");
					// A trailing rule is the full-width shape this suite exists to keep out.
					expect(row.trimEnd().endsWith(rule)).toBe(false);
				});

				it("does not span the viewport", () => {
					const row = dividerRow(make(), WIDTH);
					expect(Bun.stringWidth(row.trimEnd())).toBeLessThan(WIDTH);
				});

				it("drops the rule rather than the words when the viewport cannot hold both", () => {
					const row = dividerRow(make(), 12);
					expect(row.trimStart().startsWith(theme.tree.horizontal)).toBe(false);
					expect(row.trim().length).toBeGreaterThan(0);
				});
			});
		}
	}
});

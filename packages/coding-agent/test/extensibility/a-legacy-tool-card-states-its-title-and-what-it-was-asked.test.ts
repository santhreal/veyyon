import { describe, expect, it } from "bun:test";
import type { ToolDefinition, ToolRenderResultOptions } from "@veyyon/coding-agent/extensibility/extensions/types";
import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
} from "@veyyon/coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { Text } from "@veyyon/tui";

/**
 * WHY: the five legacy `pi-coding-agent` tool definitions draw their call card
 * through one step (title in `toolTitle` bold, detail in `toolOutput`), and each
 * detail is the tool's own argument summary. This pins every card's text for a
 * legacy theme handed in either argument slot (a pi extension passes its theme
 * where this host passes render options), and the untinted text when no theme
 * is passed. It does not draw the card, so a layout regression in `Text` is
 * outside its reach.
 */

const cwd = process.cwd();

const legacyTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `*${text}*`,
};

function cardText(definition: ToolDefinition, params: unknown, second?: unknown, third?: unknown): string {
	// The legacy slots are untyped on purpose: a pi extension's theme arrives in either one.
	const view = definition.renderCall?.(params, second as ToolRenderResultOptions, third as Theme);
	if (!(view instanceof Text)) throw new Error(`${definition.name} drew no Text card`);
	return view.getText();
}

const cards: { definition: ToolDefinition; params: unknown; detail: string }[] = [
	{ definition: createReadToolDefinition(cwd), params: { path: "src/a.ts" }, detail: "src/a.ts" },
	{ definition: createBashToolDefinition(cwd), params: { command: "ls -l" }, detail: "ls -l" },
	{ definition: createGrepToolDefinition(cwd), params: { pattern: "TODO", path: "src" }, detail: "/TODO/ in src" },
	{ definition: createFindToolDefinition(cwd), params: { pattern: "*.ts", path: "lib" }, detail: "*.ts in lib" },
	{ definition: createLsToolDefinition(cwd), params: { path: "docs" }, detail: "docs" },
];

describe("a legacy tool card states its title and what it was asked", () => {
	it.each(cards)("$definition.name: title in toolTitle bold, detail in toolOutput, theme in either slot", card => {
		const expected = `<toolTitle>*${card.definition.name}*</toolTitle> <toolOutput>${card.detail}</toolOutput>`;
		expect(cardText(card.definition, card.params, legacyTheme, undefined)).toBe(expected);
		expect(cardText(card.definition, card.params, undefined, legacyTheme)).toBe(expected);
	});

	it.each(cards)("$definition.name: plain text without a theme", card => {
		expect(cardText(card.definition, card.params)).toBe(`${card.definition.name} ${card.detail}`);
	});

	it("falls back to the cwd-relative defaults when a path or pattern is missing", () => {
		expect(cardText(createGrepToolDefinition(cwd), {})).toBe("grep // in .");
		expect(cardText(createFindToolDefinition(cwd), {})).toBe("find  in .");
		expect(cardText(createLsToolDefinition(cwd), {})).toBe("ls .");
		expect(cardText(createReadToolDefinition(cwd), {})).toBe("read ");
	});
});

/**
 * WHY. A theme file may override `tree.branch` and `tree.last` with any string. The session tree
 * places that glyph one cell per code point and fills the cells it does not cover: cell 1 gets
 * `tree.horizontal`. An index into the raw string counts UTF-16 units instead, so a one-code-point
 * astral glyph spends two cells on its own surrogate halves and the horizontal is never drawn.
 *
 * THE CLASS THIS CLOSES. Any cell-by-cell split of a themed glyph that counts UTF-16 units instead
 * of code points. The default `├─` / `└─` never trips it, so the case is driven through a theme
 * whose connectors are single code points outside the BMP.
 *
 * WHAT IT DOES NOT CATCH. A glyph that is one code point but two columns wide (the cell budget is
 * three per level either way), and grapheme clusters: a connector made of several code points is
 * still split per code point, which is the contract the gutter layout is written against.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/tree-selector";
import type { ThemeJson } from "@veyyon/coding-agent/theme/color";
import { createTheme, initTheme, setThemeInstance, type Theme, theme } from "@veyyon/coding-agent/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { cardBodyLines } from "../../../helpers/modal-card";

const DARK_THEME_PATH = path.join(import.meta.dirname, "..", "..", "..", "..", "src", "theme", "dark.json");
const BRANCH = "🌿";
const LAST = "🍂";

let counter = 0;
function makeNode(role: "user" | "assistant", text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: counter }
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: counter,
					stopReason: "stop",
				} as AgentMessage);
	const entry: SessionEntry = { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
	return { entry, children: [] };
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("a themed tree connector keeps its whole glyph", () => {
	let previous: Theme | undefined;

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		previous = theme;
		const dark = JSON.parse(await fs.readFile(DARK_THEME_PATH, "utf8")) as ThemeJson;
		const themed = createTheme({
			...dark,
			symbols: {
				...dark.symbols,
				overrides: { ...dark.symbols?.overrides, "tree.branch": BRANCH, "tree.last": LAST },
			},
		});
		setThemeInstance(themed);
	});

	afterAll(() => {
		if (previous) setThemeInstance(previous);
	});

	it("places an astral connector as one cell and never a surrogate half", () => {
		counter = 0;
		const root = makeNode("user", "root prompt");
		const reply = makeNode("assistant", "reply", root.entry.id);
		root.children.push(reply);
		const first = makeNode("user", "first sibling", reply.entry.id);
		const second = makeNode("user", "second sibling", reply.entry.id);
		const third = makeNode("user", "third sibling", reply.entry.id);
		reply.children.push(first, second, third);

		const selector = new TreeSelectorComponent(
			[root],
			second.entry.id,
			() => {},
			() => {},
		);
		const rows = cardBodyLines(selector.render(120)).map(line => Bun.stripANSI(line));

		// The active branch is drawn first, so the last sibling on screen is the third one.
		const rowOf = (needle: string): string => {
			const row = rows.find(line => line.includes(needle));
			expect(row).toBeDefined();
			return row!;
		};
		expect(rowOf("first sibling")).toContain(`${BRANCH}─`);
		expect(rowOf("second sibling")).toContain(`${BRANCH}─`);
		expect(rowOf("third sibling")).toContain(`${LAST}─`);
		for (const row of rows) expect(LONE_SURROGATE.test(row)).toBe(false);
	});
});

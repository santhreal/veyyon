/**
 * WHY: a room window's body is the prompt it is working on, then as much of
 * the end of what followed as fits, with a `⋯` row where the middle was cut.
 * The painter reads what followed from the end and stops once it has the rows
 * a window can show, so a long turn costs a window its visible rows rather
 * than its whole exchange. Reading backwards is where the defects live: a
 * paragraph break put on the wrong side of a block, a block dropped at the
 * cut, a stop one row early that loses the top of the tail, or an exchange
 * that fits cut anyway.
 *
 * The class: every body height from one row up to past the exchange's full
 * length, over an exchange that holds every block kind and every kind of
 * boundary between them (prose to tool, tool to tool, tool to prose, prose
 * running over two rows, a tool to reasoning, prose to a `#room` post and the
 * post to the prose that answers it). The expected rows are the
 * exchange as the transcript sets it, written out once below; each height's
 * body must be that list's head, cut and tail exactly.
 *
 * What it does NOT catch: wrapping itself, which is `wrapTextWithAnsi`'s, and
 * the colours of the rows.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RoomFeedBlock } from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { paintRoomWindow } from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { START_MS, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const WIDTH = 48;

const BLOCKS: readonly RoomFeedBlock[] = [
	{ kind: "prompt", text: "split the tokenizer out of the parser" },
	{ kind: "text", text: "Reading the parser first." },
	{ kind: "tool", label: "Read", detail: "src/parser.ts", state: "ok" },
	{ kind: "tool", label: "Read", detail: "src/lexer.ts", state: "ok" },
	{ kind: "text", text: "The lexer is inlined.\nIt moves out next." },
	{ kind: "tool", label: "Edit", detail: "src/tokenizer.ts", state: "ok" },
	{ kind: "thinking" },
	{ kind: "text", text: "Done: the tokenizer stands alone." },
	{ kind: "room", label: "you", body: "@1 move the tests too" },
	{ kind: "text", text: "Moving the tests." },
];

/** The body rows of a window `height` rows tall, without its frame or its padding. */
function body(height: number, blocks: readonly RoomFeedBlock[] = BLOCKS): string[] {
	const rows = paintRoomWindow({
		width: WIDTH,
		height,
		snapshot: snapshotOf({ kind: "done", at: START_MS }, blocks),
		ordinal: 1,
		strength: 1,
		selected: false,
		framed: true,
		waitingDialogs: 0,
		now: START_MS,
	});
	return rows.slice(1, -1).map(row => stripVTControlCharacters(row).slice(2, -2).trimEnd());
}

describe("a window's body", () => {
	it("is the prompt, then the whole exchange when it fits, else a cut and as much of its end as fits", () => {
		const rail = theme.symbol("block.rail");
		const head = [`${theme.nav.cursor} split the tokenizer out of the parser`];
		// What followed the prompt, as the transcript sets it: prose set off from
		// the tool rows around it by a blank row, tool rows stacked tight, and
		// reasoning under a tool with no break between them.
		const followed = [
			"Reading the parser first.",
			"",
			`${rail} Read  src/parser.ts`,
			`${rail} Read  src/lexer.ts`,
			"",
			"The lexer is inlined.",
			"It moves out next.",
			"",
			`${rail} Edit  src/tokenizer.ts`,
			"Thinking…",
			"",
			"Done: the tokenizer stands alone.",
			"",
			"#room you: @1 move the tests too",
			"",
			"Moving the tests.",
		];
		const cut = `  ${theme.status.pending}`;
		const mismatches: Array<{ inner: number; got: string[]; want: string[] }> = [];
		for (let inner = 1; inner <= head.length + 1 + followed.length + 3; inner++) {
			let want: string[];
			if (head.length + 1 + followed.length <= inner) want = [...head, "", ...followed];
			else if (inner <= head.length + 1) want = followed.slice(-inner);
			else want = [...head, cut, ...followed.slice(-(inner - head.length - 1))];
			while (want.length < inner) want.push("");
			const got = body(inner + 2);
			if (got.join("\n") !== want.join("\n")) mismatches.push({ inner, got, want });
		}
		expect(mismatches).toEqual([]);
	});

	/**
	 * A post can hold 4,000 characters. As rows it would fill the window and
	 * push out the answer it started, so it is one row, cut at the window's
	 * edge, the way a tool call is.
	 */
	it("draws a long #room post as one row cut at the edge, and the answer under it", () => {
		const long = `@1 ${"move every test beside the module it covers ".repeat(20)}`;
		const rows = body(8, [
			{ kind: "prompt", text: "split the tokenizer" },
			{ kind: "room", label: "you", body: long },
			{ kind: "text", text: "Moving the tests." },
		]).filter(row => row !== "");
		expect(rows).toHaveLength(3);
		expect(rows[1]!.startsWith("#room you: @1 move every test")).toBe(true);
		expect(rows[1]!.endsWith("…")).toBe(true);
		expect(rows[2]).toBe("Moving the tests.");
	});
});

/**
 * WHY THIS EXISTS. A `Box` padded every row out to the width it was given, background or not. On a
 * resumed transcript that is one padded copy of every row in the box memo: 61k strings and 9.7 MiB
 * at the first frame of a 38 MB synthetic session, for spaces the renderer erases with `\x1b[K`
 * anyway. A row now reaches the full width only when something is drawn past its ink.
 *
 * The class this closes: every combination of background, border, hugging and vertical padding
 * emits rows of the width that combination draws. The first cut of the change keyed the padding on
 * the background alone and shifted the right border of an unpainted framed box to the end of each
 * row's ink; the framed arms below catch that sibling.
 *
 * What it does not catch: a parent that composes rows side by side and assumes its child is full
 * width. The overlay compositor pads a short base row itself (`compositeLineAt`), and no engine
 * component joins columns, so there is no such parent to construct here.
 */
import { describe, expect, it } from "bun:test";
import { Box, type BoxBorder, type Component } from "@veyyon/tui";

const CHARS: BoxBorder["chars"] = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
};

/** Rows that end at their ink, as a tool output block emits them. */
const INK = ["ab", "abcd"];
const WIDTH = 20;
const PADDING_X = 1;

function inkChild(): Component {
	return { render: () => INK, invalidate: () => {} };
}

const paint = (text: string): string => `\x1b[48;5;236m${text}\x1b[49m`;
const cells = (row: string): number => Bun.stringWidth(Bun.stripANSI(row));

interface Arm {
	painted: boolean;
	framed: boolean;
	hug: boolean;
	paddingY: number;
}

const ARMS: Arm[] = [];
for (const painted of [false, true])
	for (const framed of [false, true])
		for (const hug of [false, true]) for (const paddingY of [0, 1]) ARMS.push({ painted, framed, hug, paddingY });

function render(arm: Arm): readonly string[] {
	const box = new Box(
		PADDING_X,
		arm.paddingY,
		arm.painted ? paint : undefined,
		arm.framed ? { chars: CHARS } : undefined,
	);
	box.setIgnoreTight(true);
	box.setHugContent(arm.hug);
	box.addChild(inkChild());
	return box.render(WIDTH);
}

function label(arm: Arm): string {
	return `painted=${arm.painted} framed=${arm.framed} hug=${arm.hug} paddingY=${arm.paddingY}`;
}

describe("Box row width", () => {
	for (const arm of ARMS.filter(a => !a.painted && !a.framed)) {
		it(`ends an unpainted, unframed row at its ink (${label(arm)})`, () => {
			const blank = Array.from({ length: arm.paddingY }, () => "");
			expect(render(arm)).toEqual([...blank, " ab", " abcd", ...blank]);
		});
	}

	for (const arm of ARMS.filter(a => a.painted || a.framed)) {
		it(`fills every row to the frame's width (${label(arm)})`, () => {
			const interior = arm.hug
				? Math.max(...INK.map(line => line.length)) + PADDING_X * 2
				: WIDTH - (arm.framed ? 2 : 0);
			const rows = render(arm);
			expect(rows.length).toBe(INK.length + arm.paddingY * 2 + (arm.framed ? 2 : 0));
			expect(rows.map(cells)).toEqual(rows.map(() => interior + (arm.framed ? 2 : 0)));
			if (arm.framed) {
				for (const row of rows.slice(1, -1)) expect(Bun.stripANSI(row).endsWith("|")).toBe(true);
			}
		});
	}
});

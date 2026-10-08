/**
 * A ` ```thinking ` block ends at the same line, with the same thinking and the same visible reply,
 * however the provider cut the stream.
 *
 * WHY THIS SUITE EXISTS. `FencedThinkingScanner` holds a top-level line whose lead could still become
 * the closer, and emits a line as content once its lead rules a fence out. The decision is made once
 * per line rather than on every delta, so a long line costs one pass instead of one pass per delta.
 * A line emitted too early leaks a closer into thinking; a line whose bytes are not kept until its
 * newline loses the nested fence it opens, and the next bare ` ``` ` inside that block then ends the
 * thinking and leaks the rest of the reasoning into the reply.
 *
 * CLASS CLOSED. Every body built from up to two line shapes (nested backtick, tilde and four-backtick
 * blocks, indented and tab-led fences, short backtick runs, a 2000-byte line), followed by every
 * closer form (bare closer then a reply, inline reply, bare closer at stream end, a held partial
 * fence or indent at stream end, no closer), yields exactly that body and any held bytes as thinking
 * and the closer's reply as visible text, fed whole and in 1-, 2-, 3-, 5- and 7-byte pieces, through
 * both scanners that own a `FencedThinkingScanner`: the Gemini dialect and the leaked-idiom healer.
 *
 * NOT CAUGHT. Time per byte is not asserted; a scanner that is correct but quadratic in line length
 * passes. Lines ending in `\r` are not in the corpus.
 */
import { describe, expect, it } from "bun:test";
import {
	createInbandScanner,
	type InbandScanEvent,
	type InbandScanner,
	ThinkingInbandScanner,
} from "@veyyon/ai/dialect";

/** Line shapes that stay inside the thinking block, each ending without its newline. */
const BLOCKS: Record<string, string> = {
	prose: "Plain reasoning line with words.",
	"backtick block": "```rs\nfn main() {}\n```",
	"tilde block holding a bare backtick fence": "~~~py\n```\nprint(1)\n~~~",
	"four-backtick block holding three-backtick lines": "````md\n```\nnested bare\n```\n````",
	"indented block": "  ```c++\nint x;\n  ```",
	"fence indented four spaces": "    ```",
	"tab-led fence": "\t```",
	"two-backtick runs": "``inline code`` and `` ``",
	"2000-byte line": "word ".repeat(400),
};

/** How the block ends: the bytes after the body, the visible reply, and the thinking held bytes add at stream end. */
const CLOSERS: Record<string, { text: string; visible: string; heldThinking: string }> = {
	"bare closer then a reply": { text: "```\nVisible reply.", visible: "\nVisible reply.", heldThinking: "" },
	"inline reply": { text: "```Visible reply", visible: "Visible reply", heldThinking: "" },
	"bare closer at stream end": { text: "```", visible: "", heldThinking: "" },
	"two backticks at stream end": { text: "``", visible: "", heldThinking: "``" },
	"indent at stream end": { text: "  ", visible: "", heldThinking: "  " },
	"no closer": { text: "", visible: "", heldThinking: "" },
};

const SCANNERS: Record<string, () => InbandScanner> = {
	"gemini dialect": () => createInbandScanner("gemini"),
	"leaked-idiom healer": () => new ThinkingInbandScanner(),
};

const PIECE_SIZES = [Number.POSITIVE_INFINITY, 1, 2, 3, 5, 7];

function scan(make: () => InbandScanner, text: string, size: number): InbandScanEvent[] {
	const scanner = make();
	const events: InbandScanEvent[] = [];
	for (let at = 0; at < text.length; at += size) events.push(...scanner.feed(text.slice(at, at + size)));
	events.push(...scanner.flush());
	return events;
}

function joined(events: readonly InbandScanEvent[]): { thinking: string; visible: string; sections: number } {
	let thinking = "";
	let visible = "";
	let sections = 0;
	for (const event of events) {
		if (event.type === "thinkingDelta") thinking += event.delta;
		else if (event.type === "text") visible += event.text;
		else if (event.type === "thinkingStart") sections += 1;
	}
	return { thinking, visible, sections };
}

const BODIES: Array<[string, string[]]> = [["empty body", []]];
for (const first of Object.keys(BLOCKS)) {
	BODIES.push([first, [BLOCKS[first]!]]);
	for (const second of Object.keys(BLOCKS)) BODIES.push([`${first} + ${second}`, [BLOCKS[first]!, BLOCKS[second]!]]);
}

describe("a thinking fence closes on the same line however its stream is cut", () => {
	for (const [scannerName, make] of Object.entries(SCANNERS)) {
		for (const [closerName, closer] of Object.entries(CLOSERS)) {
			it(`${scannerName}, ${closerName}: every body is thinking at every cut`, () => {
				const mismatches: string[] = [];
				for (const [bodyName, lines] of BODIES) {
					const body = lines.map(line => `${line}\n`).join("");
					const input = `\`\`\`thinking\n${body}${closer.text}`;
					const expected = { thinking: body + closer.heldThinking, visible: closer.visible, sections: 1 };
					for (const size of PIECE_SIZES) {
						const actual = joined(scan(make, input, size));
						if (JSON.stringify(actual) !== JSON.stringify(expected)) {
							mismatches.push(`${bodyName} in ${size}-byte pieces: ${JSON.stringify(actual).slice(0, 200)}`);
						}
					}
				}
				expect(mismatches.slice(0, 5)).toEqual([]);
			});
		}
	}
});

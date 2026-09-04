/**
 * WHY THIS EXISTS.
 *
 * A span is the one place a tool's text meets a host's markup, and three kinds of untrusted bytes
 * arrive through it: the tool's own words, another program's captured screen, and a URL a model
 * produced. A host that wrote any of the three into a document unchanged would be an injection, an
 * escape-sequence leak, or a `javascript:` link with a plugin's name on it.
 *
 * The class this closes is a span member reaching the document without the host answering for it.
 * Every member of `ViewSpan` is exercised, and the two boundaries -- escaping and the href scheme
 * allowlist -- are asserted on the inputs that break a denylist.
 *
 * WHAT IT DOES NOT CATCH. What the appearance IS: a class name says a stylesheet has something to
 * hook, not that the result reads well. That is the embedder's, and there is no capture here to
 * prove it with.
 */

import { describe, expect, it } from "bun:test";
import type { ViewSpan } from "@veyyon/view";
import { drawLine, drawSpan } from "../src/draw-tool-view";
import { STATUS_CLASSES, TONE_CLASSES, VIEW_TONES } from "../src/tokens";

describe("a span carries its meaning and never its bytes", () => {
	it("escapes every character a document would read as markup", () => {
		const drawn = drawSpan({ text: `<img src=x onerror="alert('1')">& 'quoted'` });

		expect(drawn).not.toContain("<img");
		expect(drawn).toContain("&lt;img");
		expect(drawn).toContain("&amp;");
		expect(drawn).toContain("&#39;quoted&#39;");
	});

	it("gives every tone the contract declares a class of its own", () => {
		// Swept from the host's own record at run time: a tone added to the contract is a type error
		// in `TONE_CLASSES` before it can reach this sweep, and a tone that shared a class would show
		// as a duplicate here.
		const drawnClasses = VIEW_TONES.map(tone => TONE_CLASSES[tone]);

		expect(new Set(drawnClasses).size).toBe(VIEW_TONES.length);
		for (const tone of VIEW_TONES) {
			expect(drawSpan({ text: "x", tone })).toContain(TONE_CLASSES[tone]);
		}
	});

	it("draws emphasis as the elements that mean it, and drops none of them", () => {
		const drawn = drawSpan({ text: "closed", bold: true, italic: true, strike: true });

		expect(drawn).toContain("<strong>");
		expect(drawn).toContain("<em>");
		expect(drawn).toContain("<s>");
		expect(drawn).toContain("closed");
	});

	/**
	 * A captured run is another program's screen. There is nothing to replay it onto here, so the
	 * words survive and every control sequence -- CSI, OSC, a lone escape, a bare control byte --
	 * does not.
	 */
	it("keeps the words of a captured screen and drops the sequences that drew it", () => {
		const drawn = drawSpan({ text: "\x1b[1;31mFAILED\x1b[0m\x1b]0;title\x07 build\x08", captured: true });

		// The whole body, not a substring of it: a strip that eats the escape byte and leaves `[1;31m`
		// behind satisfies every "no escape byte" assertion while putting the parameters on the screen.
		expect(drawn).toBe('<code class="v-captured">FAILED build</code>');
	});

	it("follows a link only when its scheme addresses a document", () => {
		expect(drawSpan({ text: "docs", link: "https://veyyon.dev/docs" })).toContain('href="https://veyyon.dev/docs"');
		expect(drawSpan({ text: "mail", link: "mailto:nobody@veyyon.dev" })).toContain("href=");
	});

	/**
	 * The inputs a denylist misses. Each one is a scheme a browser will execute or decode, spelled
	 * the way an attacker spells it: mixed case, a leading space, an embedded newline, a tab inside
	 * the scheme name. The allowlist answers all four the same way.
	 */
	it("refuses a scheme it does not follow, however the string is spelled", () => {
		const refused = [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"  javascript:alert(1)",
			"java\nscript:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox(1)",
			"",
		];

		for (const link of refused) {
			const drawn = drawSpan({ text: "click", link });
			expect(drawn, `${link} was followed`).not.toContain("<a ");
			expect(drawn).toContain("click");
		}
	});

	it("states a mark by the state it reports, not by a glyph the tool picked", () => {
		const drawn = drawSpan({ text: "", status: "running" });

		expect(drawn).toContain('data-status="running"');
		expect(drawn).toContain('aria-label="running"');
		expect(drawn).toContain('role="img"');
		expect(drawn).toContain(STATUS_CLASSES.running);
	});

	/**
	 * Two rows reporting the same state look the same however the tool toned the words beside them,
	 * which is only true while a mark takes the mark's appearance and never the tone on its span.
	 */
	it("draws a mark in the state's own appearance, never the tone beside it", () => {
		const drawn = drawSpan({ text: "", status: "error", tone: "success" });

		expect(drawn).toContain(STATUS_CLASSES.error);
		expect(drawn).not.toContain(TONE_CLASSES.success);
	});

	it("draws a mark from the embedder's icon set when it has one", () => {
		const withIcons = drawSpan({ text: "!", symbol: "priority.high" }, { symbols: { "priority.high": "&#9650;" } });
		const without = drawSpan({ text: "!", symbol: "priority.high" });

		expect(withIcons).toContain("&#9650;");
		expect(withIcons).toContain('data-symbol="priority.high"');
		expect(without).toContain("!");
	});

	it("names the file and the line a run points at, and the line only with the file", () => {
		const withLine = drawSpan({ text: "app.ts", file: "/repo/src/app.ts", fileLine: 42 });
		const lineAlone = drawSpan({ text: "app.ts", fileLine: 42 });

		expect(withLine).toContain('data-file="/repo/src/app.ts"');
		expect(withLine).toContain('data-file-line="42"');
		expect(lineAlone).not.toContain("data-file-line");
	});

	it("sets a badge run off as a chip and marks a live run as live", () => {
		expect(drawSpan({ text: "codex", badge: true })).toContain("v-chip");
		expect(drawSpan({ text: "reading", live: true })).toContain('data-live="true"');
	});

	it("renders an inline markdown run rather than showing its syntax", () => {
		const drawn = drawSpan({ text: "pick **this** one", markdown: true });

		expect(drawn).toContain("<strong>this</strong>");
		expect(drawn).not.toContain("**");
	});

	/**
	 * The tail is the END of a line: the first marked run opens it and nothing after it leaves it,
	 * so a host that lays a row out in columns has two halves rather than a run of interleaved ones.
	 */
	it("gathers the trailing runs of a line into one tail", () => {
		const line: readonly ViewSpan[] = [{ text: "build" }, { text: "12s", trailing: true }, { text: " ok" }];
		const drawn = drawLine(line);

		const tailAt = drawn.indexOf('class="v-trailing"');
		expect(tailAt).toBeGreaterThan(-1);
		expect(drawn.indexOf("build")).toBeLessThan(tailAt);
		expect(drawn.indexOf("12s")).toBeGreaterThan(tailAt);
		expect(drawn.indexOf(" ok")).toBeGreaterThan(tailAt);
		expect(drawn.split('class="v-trailing"').length - 1).toBe(1);
	});

	it("leaves a line with no trailing run in one piece", () => {
		expect(drawLine([{ text: "a" }, { text: "b" }])).not.toContain("v-trailing");
	});
});

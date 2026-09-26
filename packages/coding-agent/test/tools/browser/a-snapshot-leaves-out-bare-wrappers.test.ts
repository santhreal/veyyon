/**
 * WHY: layout `<div>`s appear in an aria snapshot as `- generic [ref=eN]:` lines with nothing on
 * them, 7–30% of a real page's snapshot, and every snapshot is re-sent on each later turn.
 *
 * The contract of `withoutBareWrappers`: a generic with no name, text, state, pointer or box is
 * left out and its children take its place one level up; every other line, and every ref on it, is
 * kept as it was, in order.
 *
 * What it does NOT catch: that a ref still resolves after the snapshot is compacted, which
 * `an-open-that-loads-a-small-page-sends-its-snapshot.test.ts` proves in Chromium by filling
 * through a ref from the compacted snapshot.
 */

import { describe, expect, it } from "bun:test";
import { withoutBareWrappers } from "@veyyon/coding-agent/tools/web/browser/aria-snapshot";

describe("an aria snapshot", () => {
	it("leaves out bare wrappers and lifts what they held into their place", () => {
		const snapshot = [
			"- generic [active] [ref=e1]:",
			"  - generic [ref=e2]:",
			"    - generic [ref=e3]:",
			'      - heading "Sign in" [level=1] [ref=e4]',
			"    - generic [ref=e5]: Enter your name",
			"    - textbox [ref=e6]",
			'  - button "Submit" [ref=e7]',
			"  - generic [ref=e8] [cursor=pointer]:",
			"    - text: Help",
		].join("\n");
		expect(withoutBareWrappers(snapshot)).toBe(
			[
				"- generic [active] [ref=e1]:",
				'  - heading "Sign in" [level=1] [ref=e4]',
				"  - generic [ref=e5]: Enter your name",
				"  - textbox [ref=e6]",
				'  - button "Submit" [ref=e7]',
				"  - generic [ref=e8] [cursor=pointer]:",
				"    - text: Help",
			].join("\n"),
		);
	});

	it("keeps a snapshot with no bare wrapper byte for byte", () => {
		const snapshot = [
			'- list "Nav" [ref=e1]:',
			"  - listitem [ref=e2]:",
			'    - link "Home" [ref=e3]:',
			"      - /url: /",
		].join("\n");
		expect(withoutBareWrappers(snapshot)).toBe(snapshot);
	});

	it("closes a lifted wrapper at the first line back at its own level", () => {
		const snapshot = [
			'- region "Main" [ref=e1]:',
			"  - generic [ref=e2]:",
			"    - paragraph [ref=e3]: inside",
			"  - paragraph [ref=e4]: sibling of the wrapper",
			"- paragraph [ref=e5]: outside",
		].join("\n");
		expect(withoutBareWrappers(snapshot)).toBe(
			[
				'- region "Main" [ref=e1]:',
				"  - paragraph [ref=e3]: inside",
				"  - paragraph [ref=e4]: sibling of the wrapper",
				"- paragraph [ref=e5]: outside",
			].join("\n"),
		);
	});
});

/**
 * SPEC-ONE-PLACE-AUDIT F6: single canonical `stripAnsi` (CSI+OSC superset)
 * imported by `tiny/message-preproc.ts` and the browser-bundled
 * `@veyyon/tool-render` (via `src/util.ts`), replacing two divergent copies
 * (one SGR-only, two byte-identical CSI+OSC forks).
 */
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { collectPackageSources } from "./support/package-sources";

describe("stripAnsi", () => {
	it("strips SGR color/style sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips non-SGR CSI sequences (cursor movement, erase)", () => {
		expect(stripAnsi("\x1b[2K\x1b[1Ahello")).toBe("hello");
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(stripAnsi("\x1b]0;window title\x07visible")).toBe("visible");
	});

	it("strips OSC sequences terminated by ST (ESC \\\\)", () => {
		expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\")).toBe("link text");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain text, no escapes")).toBe("plain text, no escapes");
	});
});

// Repo-wide source lock: stripAnsi has exactly ONE owner,
// packages/utils/src/strip-ansi.ts (the CSI+OSC superset). Local copies drift —
// the sweep that landed this lock found six, three under one name with three
// DIFFERENT behaviors (SGR-only, full CSI, Node stripVTControlCharacters). The
// owner's docstring is explicit that an SGR-only strip is materially different
// and must not reuse this name, so any `function stripAnsi` outside the owner is
// a violation. Both src and test are scanned — a test-helper copy is still a
// second definition that drifts (that is where these copies hid). Import the
// owner; a narrower stripper needs its own honest name (e.g. stripSgr).
const OWNER = "utils/src/strip-ansi.ts";
const STRIPANSI_DEF = /function\s+stripAnsi\s*\(/;

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources). Both src and test are scanned — a test-helper
// copy is still a second definition that drifts (that is where these copies hid).
describe("stripAnsi source lock", () => {
	it("no source or test file defines a local stripAnsi outside the owner", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src", "test"], includeTests: true })) {
			if (rel === OWNER) continue;
			if (STRIPANSI_DEF.test(text)) offenders.push(rel);
		}
		expect(
			offenders,
			"local stripAnsi copies — import it from @veyyon/utils; a narrower stripper needs its own name",
		).toEqual([]);
	});
});

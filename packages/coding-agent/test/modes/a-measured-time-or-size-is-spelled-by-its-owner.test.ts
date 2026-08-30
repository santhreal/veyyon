/**
 * WHY:
 * Two facts on one row disagreed about how to write themselves. The turn receipt
 * under a finished message printed its wall clock through `formatDuration` and
 * its time to first token through `(ms / 1000).toFixed(1)`, so a 420ms latency
 * beside a 14.2s turn read `ttft 0.4s` where the owner would have said `420ms` —
 * two spellings, one row, one unit apart. The model picker spelled the SAME
 * measurement a third way (`0.4s`, whole seconds from ten up), so the number a
 * reader compared across the two surfaces was not written the same way on either.
 * Sizes had the same split: a screenshot block reported `2867.20 KB` where every
 * other size on screen reads `2.8MB`, because it divided by 1024 once and stopped,
 * and `write-accounting.ts` exported a second byte formatter whose output was
 * `3.00 GB` against the owner's `3.0GB`.
 *
 * The class this suite closes: a MEASURED duration or byte size that a person
 * reads is spelled by its owner — `formatDuration` and `formatBytes` — on every
 * surface, so the same quantity is written the same way whichever surface shows
 * it, and a sub-second measurement keeps its milliseconds instead of rounding to
 * a tenth of a second.
 *
 * The boundary, which is the reason this is one class and not a sweep of every
 * number: a MEASURED quantity goes through the owner, a CONFIGURED limit is
 * stated in the unit it was configured in. `session.writeBudgetGb` of 2 stays
 * `2 GB` in the refusal that names it, and a timeout of 30000ms stays `30s` in
 * the error that reports it, because those are the operator's own numbers being
 * read back. What is measured — bytes written, a wall clock, a latency, an age —
 * is the owner's.
 *
 * What it does not catch: the ticking clock (`formatClock`) and the coarse
 * account-manager spelling (`formatDurationCoarse`), which are deliberate
 * separate house styles for a live readout and for a reset window; a duration in
 * text written for the model rather than the screen; and whether a row is legible
 * at a given contrast, which is a capture's job.
 */

import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model, Usage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildBrowserItems, ModelBrowser } from "@veyyon/coding-agent/modes/components/model-browser";
import { createUsageRowBlock } from "@veyyon/coding-agent/modes/components/usage-row";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { formatScreenshot } from "@veyyon/coding-agent/tools/render-utils";
import { formatBytes, formatDuration } from "@veyyon/utils/format";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

const SRC = path.resolve(import.meta.dir, "../../src");

/** Every `.ts` under `src`, vendored trees and tests excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "vendor") sources(full, found);
			continue;
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
	}
	return found;
}

/** Source lines with comments dropped, as `[line number, text]`. */
function codeLines(source: string): Array<[number, string]> {
	return source
		.split("\n")
		.map((line, index): [number, string] => [index + 1, line])
		.filter(([, line]) => {
			const start = line.trimStart();
			return !start.startsWith("*") && !start.startsWith("//") && !start.startsWith("/*");
		});
}

/**
 * Files the sweep may not judge, each with the reason it is outside the class.
 * A file, not a line, because a line number goes stale on an unrelated edit and
 * a silent exemption is the same defect as no sweep. Pinned by exact equality
 * below, so a stale entry fails as loudly as a new offender.
 */
const EXEMPT: Record<string, string> = {
	"debug/profiler.ts":
		"divides MICROseconds into milliseconds; the class is milliseconds into seconds, and V8 sample deltas arrive in microseconds",
	"eval/jl/executor.ts": "reads back a CONFIGURED cell timeout in the whole seconds it was configured in",
	"tools/bash.ts":
		"reconstructs the exact bytes of a wall-time line retired from the payload, so a session recorded before that still folds; it is never printed",
	"tools/file-search.ts": "reads back a CONFIGURED search timeout in the seconds it was configured in",
	"tools/text-search.ts": "reads back the CONFIGURED native-grep file ceiling in the megabytes the constant states",
};

/** Every `path:line` a pattern hits, exemptions included. */
function hits(pattern: RegExp): string[] {
	return sources(SRC).flatMap(file =>
		codeLines(fs.readFileSync(file, "utf8"))
			.filter(([, line]) => pattern.test(line))
			.map(([number]) => `${path.relative(SRC, file)}:${number}`),
	);
}

function offenders(pattern: RegExp): string[] {
	return hits(pattern).filter(hit => EXEMPT[hit.slice(0, hit.lastIndexOf(":"))] === undefined);
}

/**
 * A byte count divided into a unit at the call site. The owner is the only place
 * that may do the division, and it is in another package, so any hit here is a
 * second spelling.
 */
const HAND_DIVIDED_SIZE = /\/\s*1024\s*\)?\s*\)?\.toFixed\(|\/\s*\(?\s*1024\s*\*\s*1024/;

/**
 * Milliseconds turned into seconds with a decimal at the call site: `(ms /
 * 1000).toFixed(1)`. This is the measured shape, and it is the one that lost a
 * sub-second value's milliseconds. `Math.round(ms / 1000)` is left alone: every
 * remaining site reads back a CONFIGURED timeout, which keeps its own unit.
 */
const HAND_DIVIDED_SECONDS = /\/\s*1_?000\s*\)\s*\.toFixed\(/;

/** A duration already in seconds, printed with a decimal and an `s` glued on. */
const HAND_SPELLED_SECONDS = /econds\.toFixed\(\d\)\}s/;

function usage(): Usage {
	return {
		input: 1000,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1500,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The receipt's one rendered line, unpainted. */
function receipt(durationMs: number, ttftMs: number): string {
	initTheme();
	return stripAnsi(createUsageRowBlock(usage(), durationMs, ttftMs).render(120).join(""));
}

function model(): Model {
	return buildModel({
		id: "measured",
		name: "measured",
		api: "ollama-chat",
		provider: "local",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

/** The picker's rows with a measured latency against one model. */
function pickerRows(ttftMs: number): string {
	initTheme();
	const browser = new ModelBrowser(Settings.isolated({}));
	browser.setItems(buildBrowserItems([model()]));
	browser.setPerfStats(new Map([["local/measured", { tps: 42, ttftMs, samples: 3 }]]));
	return stripAnsi(browser.render(160).join("\n"));
}

describe("a measured quantity on screen", () => {
	/**
	 * The defect exactly: one row, two times, and the sub-second one rounded to a
	 * tenth of a second by a second spelling. Both are the owner's now, so the
	 * latency keeps its milliseconds.
	 */
	it("spells both times on the turn receipt the same way", () => {
		const text = receipt(14_200, 420);

		expect(text).toContain(formatDuration(14_200));
		expect(text).toContain(`ttft ${formatDuration(420)}`);
		expect(text).toContain("ttft 420ms");
		expect(text).not.toContain("0.4s");
	});

	/**
	 * The same measurement on a second surface. A reader comparing the picker's
	 * badge against the receipt is comparing one number, so it is written once.
	 */
	it("spells a latency in the model picker the way the receipt spells it", () => {
		const rows = pickerRows(420);

		expect(rows).toContain(formatDuration(420));
		expect(rows).not.toContain("0.4s");
	});

	/**
	 * The size defect: a screenshot block divided by 1024 once, so a megabyte-sized
	 * capture reported four digits of kilobytes and never promoted its unit.
	 */
	it("promotes a screenshot's size into the unit the number is legible in", () => {
		const resized = new Uint8Array(4096);
		const lines = formatScreenshot({
			saveFullRes: true,
			savedMimeType: "image/png",
			savedByteLength: 2_936_012,
			dest: "/repo/shot.png",
			resized: {
				mimeType: "image/webp",
				buffer: resized,
				width: 800,
				height: 600,
				wasResized: false,
				decodeFailed: false,
				originalWidth: 800,
				originalHeight: 600,
				get data(): string {
					return Buffer.from(resized).toString("base64");
				},
			},
		});
		const text = lines.join("\n");

		expect(text).toContain(formatBytes(2_936_012));
		expect(text).toContain("2.8MB");
		expect(text).not.toContain("KB) to");
		expect(text).toContain(formatBytes(4096));
	});

	/**
	 * The owner's own boundary, asserted here because both surfaces above depend on
	 * it: a sub-second measurement is milliseconds and a value past a second is a
	 * tenth of a second. A change to either would silently retune every row in the
	 * class.
	 */
	it("keeps milliseconds under a second and a decimal above one", () => {
		expect(formatDuration(420)).toBe("420ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatBytes(2048)).toBe("2.0KB");
		expect(formatBytes(2_936_012)).toBe("2.8MB");
	});
});

describe("no second spelling of a measured quantity", () => {
	/**
	 * The sweep, so a forty-first site cannot arrive quietly. It reads the source
	 * tree at run time rather than a list written here, which is the only version
	 * that stays true as the tree grows.
	 */
	it("divides no byte count into a unit at a call site", () => {
		expect(offenders(HAND_DIVIDED_SIZE)).toEqual([]);
	});

	it("turns no measured millisecond count into a decimal of seconds at a call site", () => {
		expect(offenders(HAND_DIVIDED_SECONDS)).toEqual([]);
	});

	it("glues no `s` onto a duration already in seconds", () => {
		expect(offenders(HAND_SPELLED_SECONDS)).toEqual([]);
	});

	/**
	 * An exemption earns itself or it goes. A file whose hand spelling was routed
	 * to the owner, or moved, leaves an entry here that would quietly excuse the
	 * next hand spelling written into that file, so the set is pinned by exact
	 * equality in both directions.
	 */
	it("holds no exemption that has stopped applying", () => {
		const matching = [
			...new Set(
				[HAND_DIVIDED_SIZE, HAND_DIVIDED_SECONDS, HAND_SPELLED_SECONDS]
					.flatMap(pattern => hits(pattern))
					.map(hit => hit.slice(0, hit.lastIndexOf(":"))),
			),
		].sort();

		expect(matching).toEqual(Object.keys(EXEMPT).sort());
	});

	/**
	 * The sweep has to be able to fail, and a regex that matches nothing anywhere
	 * passes the three arms above for the wrong reason. Fed the shapes the defect
	 * had, each pattern fires.
	 */
	it("recognises the spellings it is looking for", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture quotes the source line the screenshot block used to carry
		expect(HAND_DIVIDED_SIZE.test("`(${(bytes / 1024).toFixed(2)} KB)`")).toBe(true);
		expect(HAND_DIVIDED_SIZE.test("const mb = bytes / (1024 * 1024);")).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture quotes the source line the turn receipt used to carry
		expect(HAND_DIVIDED_SECONDS.test("`ttft ${(ttftMs / 1000).toFixed(1)}s`")).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture quotes the source line run-experiment used to carry
		expect(HAND_SPELLED_SECONDS.test("`PASSED in ${details.durationSeconds.toFixed(1)}s`")).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture quotes a configured timeout, which the sweep must not match
		expect(HAND_DIVIDED_SECONDS.test("`after ${Math.round(waitMs / 1000)}s`")).toBe(false);
	});
});

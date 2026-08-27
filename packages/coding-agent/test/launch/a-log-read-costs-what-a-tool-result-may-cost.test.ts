/**
 * A `launch` log read is held to the `tools.artifactSpillThreshold` budget every other tool
 * result is held to, and says which end of the log it dropped.
 *
 * WHY THIS SUITE EXISTS. The broker capped its own read at a fixed 256KB and the tool returned
 * whatever came back, so `launch logs` could deliver a quarter of a megabyte of dev-server output
 * into a request whatever the setting said, and said nothing about it. A tool result is sent again
 * on every later request of the session, so those bytes are billed once per remaining request.
 *
 * The class this closes: a tool result that prices itself against a compiled constant instead of
 * `inlineBudgetFor`. `read`, `@path` mentions, directory and archive listings and glob path lists
 * have their own suites; this one covers the launch log path, in both directions, and asserts the
 * drop is spoken rather than silent.
 *
 * WHAT IT DOES NOT CATCH. The broker's own 256KB read cap, which bounds what a daemon holds in
 * memory rather than what a request carries, and the TUI component, which renders from
 * `details.terminalRows` and not from this string.
 */
import { describe, expect, it } from "bun:test";
import type { DaemonRpcResult } from "@veyyon/coding-agent/launch/protocol";
import { toolContent } from "@veyyon/coding-agent/tools/launch";
import type { InlinePricingSource } from "@veyyon/coding-agent/tools/output-artifact";

const LINE_WIDTH = 200;
const LINE_COUNT = 1_000;

function logText(): string {
	return `${Array.from(
		{ length: LINE_COUNT },
		(_, index) => `${String(index).padStart(4, "0")} ${"L".repeat(LINE_WIDTH)}`,
	).join("\n")}\n`;
}

function pricing(kb: number): InlinePricingSource {
	return {
		settings: { get: (key: string) => (key === "tools.artifactSpillThreshold" ? kb : undefined) },
	} as unknown as InlinePricingSource;
}

function logs(text: string): DaemonRpcResult {
	return { op: "logs", name: "web", text, terminalText: undefined, cursor: 4096, state: "ready", timedOut: false };
}

function render(text: string, kb: number, head: boolean): string {
	return toolContent(logs(text), { op: "logs", name: "web", head } as never, pricing(kb));
}

describe("a log read costs what a tool result may cost", () => {
	it("holds a tail read to the configured budget and drops the oldest lines", () => {
		const rendered = render(logText(), 8, false);
		expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThan(8 * 1024 + LINE_WIDTH * 3);
		expect(rendered).toContain("0999 ");
		expect(rendered).not.toContain("0000 ");
		expect(rendered).toContain("Oldest log lines dropped");
		expect(rendered).toContain("8.0KB output budget");
		expect(rendered).toContain("[web: ready; cursor=4096]");
	});

	it("drops the newest lines when the caller asked for the head", () => {
		const rendered = render(logText(), 8, true);
		expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThan(8 * 1024 + LINE_WIDTH * 3);
		expect(rendered).toContain("0000 ");
		expect(rendered).not.toContain("0999 ");
		expect(rendered).toContain("Newest log lines dropped");
	});

	it("names how many lines of how many it showed", () => {
		const rendered = render(logText(), 8, false);
		const notice = /: (\d+) of (\d+) shown/.exec(rendered);
		expect(notice).not.toBeNull();
		expect(Number(notice?.[2])).toBe(LINE_COUNT + 1);
		const shown = Number(notice?.[1]);
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(LINE_COUNT);
	});

	it("scales with the setting rather than a compiled constant", () => {
		const small = Buffer.byteLength(render(logText(), 8, false), "utf-8");
		const large = Buffer.byteLength(render(logText(), 64, false), "utf-8");
		expect(large).toBeGreaterThan(small * 2);
		expect(large).toBeLessThan(64 * 1024 + LINE_WIDTH * 3);
	});

	it("leaves a log inside the budget whole and unannotated", () => {
		const rendered = render("first\nsecond\nthird\n", 8, false);
		expect(rendered).toBe("first\nsecond\nthird\n[web: ready; cursor=4096]");
	});
});

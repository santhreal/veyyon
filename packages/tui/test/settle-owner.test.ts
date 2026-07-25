/**
 * ONE-PLACE lock for "wait until the TUI has painted".
 *
 * Why this suite exists: fifteen integration suites each hand-rolled that wait,
 * and two of the copies produced failures in a 378,310-test sweep that were
 * green 3/3 alone and read exactly like regressions — `overlay-scroll` asserting
 * on `"status-before"` one frame after setting `"status-after"`, and the
 * pinned-composer suite freezing a view that three still-queued wheel events
 * then moved. The wait now has one owner, `settleFrames` in
 * `test/helpers/settle-frames.ts`, which asks the engine (`TUI.renderPending`)
 * instead of sleeping a guessed number of milliseconds.
 *
 * This lock fails when a suite that drives a real `TUI` grows a local settle
 * helper again that does not go through the owner. It checks the helper's body,
 * not merely the file's imports: a suite may legitimately keep a wrapper that
 * sleeps out a real debounce window (the editor's 100 ms autocomplete debounce,
 * the 120 ms resize settle) before settling the frame that follows, and those
 * wrappers still have to end at the owner.
 */
import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

const TUI_TEST_DIR = path.join(import.meta.dir);
const CODING_AGENT_TEST_DIR = path.resolve(import.meta.dir, "..", "..", "coding-agent", "test");

/**
 * A FUNCTION named for waiting on a frame. The `(?=\()|=\s*(?:async|\()` tail
 * matters: `resize-viewport-defer` has a local string named `settle` (captured
 * writes), and flagging that would have pushed a fake-scheduler suite onto a
 * helper it must not use.
 */
const SETTLE_HELPER =
	/\b(?:async function\s+(?:settle|settleFrame|settleResize|flushRender)\s*\(|const\s+(?:settle|settleFrame|settleResize|flushRender)\s*=\s*(?:async|\())/;
/** The owner's own module, and the suite that tests it, define it rather than use it. */
const OWNER_FILES = new Set(["helpers/settle-frames.ts", "render-pending-settle.test.ts"]);

interface Suite {
	rel: string;
	text: string;
}

async function walk(dir: string, base: string, out: Suite[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "fixtures") continue;
			await walk(full, base, out);
		} else if (entry.name.endsWith(".test.ts")) {
			out.push({ rel: path.relative(base, full).replaceAll(path.sep, "/"), text: await Bun.file(full).text() });
		}
	}
}

const suites: Suite[] = [];
await walk(TUI_TEST_DIR, TUI_TEST_DIR, suites);
await walk(CODING_AGENT_TEST_DIR, CODING_AGENT_TEST_DIR, suites);

/**
 * Suites that construct a real `TUI` on the production scheduler and define a
 * settle helper of their own.
 *
 * A suite injecting `StressRenderScheduler` steps time by hand and drains its
 * own scheduler, which is exact by construction — those must NOT be pushed onto
 * `settleFrames`, so they are excluded by what they do, not by a name list.
 */
const localSettlers = suites.filter(
	suite =>
		!OWNER_FILES.has(suite.rel) &&
		suite.text.includes("new TUI(") &&
		!suite.text.includes("StressRenderScheduler") &&
		SETTLE_HELPER.test(suite.text),
);

describe("frame-settling ownership", () => {
	/** Guards the guard. A traversal that finds nothing would make the contract
	 *  below pass while checking no file at all. */
	it("finds the suites that drive a real TUI and settle frames", () => {
		expect(localSettlers.length).toBeGreaterThan(5);
		expect(localSettlers.map(s => s.rel)).toContain("overlay-scroll.test.ts");
	});

	/** THE contract: a local settle helper must delegate to the owner. Reported as
	 *  `{ rel, callsOwner, importsOwner }` so a failure names the file instead of
	 *  dumping its whole source. */
	it.each(localSettlers.map(s => s.rel))("%s settles through settleFrames", rel => {
		const suite = localSettlers.find(s => s.rel === rel);

		expect({
			rel,
			callsOwner: suite?.text.includes("settleFrames(") ?? false,
			importsOwner: /import \{ settleFrames \} from "[^"]*helpers\/settle-frames"/.test(suite?.text ?? ""),
		}).toEqual({ rel, callsOwner: true, importsOwner: true });
	});

	/**
	 * The owner is a single module. A suite that declared its own `settleFrames`
	 * would satisfy the name check above while drifting from the real one, which is
	 * precisely how the fifteen original copies came about.
	 */
	it("declares settleFrames nowhere but the owner module", () => {
		const declarations = suites.filter(suite =>
			/(?:async function|const|function)\s+settleFrames\b/.test(suite.text),
		);

		expect(declarations.map(s => s.rel)).toEqual([]);
	});
});

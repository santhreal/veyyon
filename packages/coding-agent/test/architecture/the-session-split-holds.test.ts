/**
 * WHY: `agent-session.ts` carried 1430 lines of module-level declarations — the
 * event union, the config record, the permission table, the queue readers, the
 * retry-fallback selector grammar, the compaction verdicts and the message-shape
 * readers — mixed in with the class that uses them. Those declarations touch no
 * instance state, so every importer of one of them pulled in the whole runtime.
 * They now live in six sibling modules.
 *
 * The defect class this closes is a split that unwinds: a sibling that imports
 * back from `agent-session.ts` (which makes the pair one module again with two
 * files), a sibling that grows into a second runtime, or a seventh concern
 * appearing without a decision. The sibling set is read off the directory at run
 * time, so adding one turns this red until it is recorded here.
 *
 * The ceilings are MEASURED, not aspirational. `agent-session.ts` is still one
 * deeply interconnected state machine: its largest member is 756 lines with 94
 * self-references and its mean member is about 18 lines, so no further split into
 * siblings exists without a collaborator holding a back-reference to the session,
 * which would move the graph rather than cut it. The ceiling records where the
 * file is and ratchets down; it does not claim the file is small.
 *
 * What it does not catch: a sibling that stays small and wrong, and a
 * declaration filed under the sibling whose name reads best rather than the
 * concern it belongs to.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { importSpecifiers, lineCount, repoPath, subdirectories } from "./helpers/module-graph";

const SESSION_DIR = repoPath("packages/coding-agent/src/session");
const RUNTIME = `${SESSION_DIR}/agent-session.ts`;
const FACADE = `${SESSION_DIR}/facade.ts`;

/**
 * MEASURED at 19704 lines after the declarations moved out. The class itself is
 * unchanged; this number falls when a member family leaves it.
 */
const RUNTIME_CEILING = 20_000;

/** MEASURED: the largest sibling is `agent-session-types.ts` at 782 lines. */
const SIBLING_CEILING = 900;

/** MEASURED: the facade is 342 lines. */
const FACADE_CEILING = 500;

/**
 * The six concerns that left the runtime, pinned by exact equality. A seventh
 * sibling, or one renamed, fails here before it fails anywhere useful.
 */
const SIBLINGS = [
	"agent-session-compaction-policy.ts",
	"agent-session-message-shapes.ts",
	"agent-session-permissions.ts",
	"agent-session-queue.ts",
	"agent-session-retry-fallback.ts",
	"agent-session-types.ts",
] as const;

/** Every `agent-session-*.ts` beside the runtime, derived from the directory. */
function siblingFiles(): string[] {
	return readdirSync(SESSION_DIR)
		.filter(name => name.startsWith("agent-session-") && name.endsWith(".ts"))
		.sort();
}

describe("the modules the session runtime was split into", () => {
	it("are exactly the six concerns that left it", () => {
		expect(siblingFiles()).toEqual([...SIBLINGS]);
	});

	it("never import back from the runtime", () => {
		const offenders: string[] = [];
		for (const name of siblingFiles()) {
			for (const specifier of importSpecifiers(`${SESSION_DIR}/${name}`)) {
				const resolved = specifier.replace(/\.ts$/, "");
				if (resolved === "./agent-session" || resolved.endsWith("/session/agent-session")) {
					offenders.push(`${name} -> ${specifier}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("stay under the measured sibling ceiling", () => {
		const oversized = siblingFiles()
			.map(name => ({ name, lines: lineCount(`${SESSION_DIR}/${name}`) }))
			.filter(entry => entry.lines > SIBLING_CEILING);
		expect(oversized).toEqual([]);
	});

	it("are each smaller than the runtime they left", () => {
		const runtime = lineCount(RUNTIME);
		for (const name of siblingFiles()) {
			expect(lineCount(`${SESSION_DIR}/${name}`)).toBeLessThan(runtime);
		}
	});
});

describe("the session runtime's size", () => {
	it("stays under the measured ceiling", () => {
		expect(lineCount(RUNTIME)).toBeLessThanOrEqual(RUNTIME_CEILING);
	});

	it("has a ceiling tight enough to fail on real growth", () => {
		expect(RUNTIME_CEILING).toBeLessThanOrEqual(Math.round(lineCount(RUNTIME) * 1.05));
	});
});

describe("the facade's size", () => {
	it("stays under the measured ceiling", () => {
		expect(lineCount(FACADE)).toBeLessThanOrEqual(FACADE_CEILING);
	});

	it("is a small fraction of the runtime it wraps", () => {
		expect(lineCount(FACADE) * 20).toBeLessThan(lineCount(RUNTIME));
	});
});

describe("the session directory", () => {
	it("holds no subdirectory, so a sibling cannot hide in one", () => {
		expect(subdirectories(SESSION_DIR)).toEqual([]);
	});
});

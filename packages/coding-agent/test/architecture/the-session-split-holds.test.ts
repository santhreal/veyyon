/**
 * WHY: `agent-session.ts` carried 1430 lines of module-level declarations — the
 * event union, the config record, the permission table, the queue readers, the
 * retry-fallback selector grammar, the compaction verdicts and the message-shape
 * readers — mixed in with the class that uses them. Those declarations touch no
 * instance state, so every importer of one of them pulled in the whole runtime.
 * They now live in six sibling modules. Two families of instance state have since
 * left too — TTSR and the todo board — as collaborators under `runtime/`, each
 * owning its own fields behind a host interface it declares.
 *
 * The defect class this closes is a split that unwinds. Three shapes of it:
 * a sibling or collaborator that imports back from `agent-session.ts`, which makes
 * the pair one module with two files and neither constructible alone; a sibling
 * that grows into a second runtime; and a new concern appearing without a
 * decision. Both sets are read off the directory at run time and pinned by exact
 * equality, so adding one turns this red until it is recorded here.
 *
 * The ceilings are MEASURED, not aspirational, and they ratchet DOWN: the second
 * size test fails when a ceiling sits more than 5% above the file, so a family
 * that leaves the class must be recorded as a smaller number rather than left as
 * slack for the next one to grow into.
 *
 * What it does not catch: a sibling that stays small and wrong, a declaration
 * filed under the sibling whose name reads best rather than the concern it
 * belongs to, and a collaborator whose host interface names the whole session —
 * width is a judgement this cannot make, and a 60-member host would pass here.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { importSpecifiers, lineCount, repoPath, subdirectories } from "./helpers/module-graph";

const SESSION_DIR = repoPath("packages/coding-agent/src/session");
const RUNTIME = `${SESSION_DIR}/agent-session.ts`;
const FACADE = `${SESSION_DIR}/facade.ts`;

/**
 * MEASURED at 18356 lines. Three families have left the class since the
 * declarations did — TTSR, the todo board and the thinking level, now
 * collaborators under `runtime/` — and this number falls again when the next
 * one leaves. It ratchets down only: a ceiling left as slack above a shrinking
 * file stops being a bound.
 */
const RUNTIME_CEILING = 18_400;

/** The one subdirectory `src/session/` holds: the collaborators. */
const RUNTIME_DIR = "runtime";

/**
 * Collaborators that own a subsystem's state, pinned by exact equality. A new
 * one fails here before it fails anywhere useful, which is the point: a
 * collaborator is a decision about where state lives, not a file drop.
 */
const COLLABORATORS = ["thinking-runtime.ts", "todo-runtime.ts", "ttsr-runtime.ts"] as const;

/** MEASURED: the larger collaborator is `ttsr-runtime.ts` at 866 lines. */
const COLLABORATOR_CEILING = 1_000;

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

/** Every module inside `runtime/`, derived from the directory. */
function collaboratorFiles(): string[] {
	return readdirSync(`${SESSION_DIR}/${RUNTIME_DIR}`)
		.filter(name => name.endsWith(".ts"))
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
	it("holds only the collaborator directory, so a sibling cannot hide in one", () => {
		expect(subdirectories(SESSION_DIR)).toEqual([`${SESSION_DIR}/${RUNTIME_DIR}`]);
	});
});

describe("the collaborators the session runtime delegates to", () => {
	it("are exactly the subsystems recorded here", () => {
		expect(collaboratorFiles()).toEqual([...COLLABORATORS]);
	});

	/**
	 * The defect that makes an extraction pointless: the collaborator declares a
	 * host interface, then reaches around it by importing the session anyway, so
	 * the pair is one module with two files and neither can be constructed alone.
	 * The declaration siblings (`agent-session-types.ts` and the rest) are fine to
	 * import — they hold no instance state, which is why they left first.
	 */
	it("never import back from the runtime", () => {
		const offenders: string[] = [];
		for (const name of collaboratorFiles()) {
			for (const specifier of importSpecifiers(`${SESSION_DIR}/${RUNTIME_DIR}/${name}`)) {
				const resolved = specifier.replace(/\.ts$/, "");
				if (resolved === "../agent-session" || resolved.endsWith("/session/agent-session")) {
					offenders.push(`${name} -> ${specifier}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("stay under the measured collaborator ceiling", () => {
		const oversized = collaboratorFiles()
			.map(name => ({ name, lines: lineCount(`${SESSION_DIR}/${RUNTIME_DIR}/${name}`) }))
			.filter(entry => entry.lines > COLLABORATOR_CEILING);
		expect(oversized).toEqual([]);
	});
});

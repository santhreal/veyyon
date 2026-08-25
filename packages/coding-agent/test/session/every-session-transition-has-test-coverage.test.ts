/**
 * Every session state transition has test coverage.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle: if the port passes every test, behavior is identical. A session
 * lifecycle transition with no test coverage is a parity gap — the rewrite
 * can change how sessions start, resume, fork, switch, close, or handle
 * instrumentation changes, and nothing goes red.
 *
 * This suite derives the session lifecycle states and transition reasons
 * from source at runtime (SessionLifecycleState, SessionLifecycleReason in
 * session-entries.ts and #startLifecycle / #endLifecycle in session-manager.ts)
 * and asserts that every transition is either covered by a dedicated lifecycle
 * test suite or audited with an explicit exemption note.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SESSION_ENTRIES_SRC = join(import.meta.dir, "..", "..", "src", "session", "session-entries.ts");
const SESSION_MANAGER_SRC = join(import.meta.dir, "..", "..", "src", "session", "session-manager.ts");
const TEST_ROOT = join(import.meta.dir, "..");

export interface SessionTransition {
	reason: string;
	targetState: string;
}

/** Extract SessionLifecycleState string literals from session-entries.ts. */
export function extractLifecycleStates(): string[] {
	const source = readFileSync(SESSION_ENTRIES_SRC, "utf-8");
	const match = source.match(/export type SessionLifecycleState =\s*([^;]+);/);
	if (!match) throw new Error("Could not find SessionLifecycleState in session-entries.ts");
	return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort();
}

/** Extract SessionLifecycleReason string literals from session-entries.ts. */
export function extractLifecycleReasons(): string[] {
	const source = readFileSync(SESSION_ENTRIES_SRC, "utf-8");
	const match = source.match(/export type SessionLifecycleReason =\s*([^;]+);/);
	if (!match) throw new Error("Could not find SessionLifecycleReason in session-entries.ts");
	return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort();
}

/** Extract state transitions by inspecting lifecycle transition methods in session-manager.ts. */
export function extractSessionTransitions(): SessionTransition[] {
	const source = readFileSync(SESSION_MANAGER_SRC, "utf-8");
	const startMatch = source.match(/#startLifecycle\(\s*reason:\s*Extract<[^,]+,\s*([^>]+)>/);
	const endMatch = source.match(/#endLifecycle\(\s*reason:\s*Extract<[^,]+,\s*([^>]+)>/);

	if (!startMatch || !endMatch) {
		throw new Error("Could not find #startLifecycle or #endLifecycle in session-manager.ts");
	}

	const transitions: SessionTransition[] = [];
	for (const m of startMatch[1].matchAll(/"([^"]+)"/g)) {
		transitions.push({ reason: m[1], targetState: "running" });
	}
	for (const m of endMatch[1].matchAll(/"([^"]+)"/g)) {
		transitions.push({ reason: m[1], targetState: "ended" });
	}

	return transitions.sort((a, b) => a.reason.localeCompare(b.reason));
}

/** Recursively collect every .test.ts file under a root. */
function collectTestFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				stack.push(full);
			} else if (entry.endsWith(".test.ts")) {
				out.push(full);
			}
		}
	}
	return out;
}

const ALL_TEST_FILES = collectTestFiles(TEST_ROOT);

/** Files dedicated to session lifecycle and transition testing. */
const LIFECYCLE_TEST_FILES = ALL_TEST_FILES.filter(file => {
	const base = file.split("/").pop()!;
	if (base.includes("every-session-transition-has-test-coverage")) return false;
	return base.includes("session-lifecycle") || base.includes("session-transition") || base.includes("session-stats");
});

/** Check whether a transition reason has direct coverage in lifecycle test suites. */
function hasDedicatedTest(reason: string): boolean {
	return LIFECYCLE_TEST_FILES.some(file => {
		const content = readFileSync(file, "utf-8");
		return content.includes(`"${reason}"`) || content.includes(`'${reason}'`);
	});
}

/** Transitions tested via indirect workflows rather than dedicated lifecycle telemetry assertions. */
const TESTED_INDIRECTLY: Record<string, string> = {
	new_session: "newSession() lifecycle end transition tested via session-manager/file-operations and acp-agent suites",
};

describe("every session state transition has test coverage", () => {
	const states = extractLifecycleStates();
	const reasons = extractLifecycleReasons();
	const transitions = extractSessionTransitions();

	it("session lifecycle states and reasons are defined and non-empty", () => {
		expect(states.length).toBeGreaterThan(0);
		expect(reasons.length).toBeGreaterThan(0);
		expect(transitions.length).toBeGreaterThan(0);
	});

	it("all declared lifecycle reasons map to a valid target state transition", () => {
		const transitionReasons = transitions.map(t => t.reason).sort();
		expect(transitionReasons).toEqual(reasons);
		for (const t of transitions) {
			expect(states).toContain(t.targetState);
		}
	});

	for (const transition of transitions) {
		const label = `${transition.reason} -> ${transition.targetState}`;
		it(`transition "${label}" has dedicated test coverage or is audited via indirect coverage`, () => {
			const hasDirect = hasDedicatedTest(transition.reason);
			const hasIndirect = transition.reason in TESTED_INDIRECTLY;
			expect(
				hasDirect || hasIndirect,
				`Transition "${label}" has no dedicated test coverage and no indirect coverage note. ` +
					"Add a test in session-lifecycle-telemetry.test.ts or record an audited exemption in TESTED_INDIRECTLY.",
			).toBe(true);
		});
	}

	it("the indirect exemption list is exhaustive for transitions without direct test coverage", () => {
		const withoutDirect = transitions.filter(t => !hasDedicatedTest(t.reason));
		const unaccounted = withoutDirect.filter(t => !(t.reason in TESTED_INDIRECTLY));
		expect(unaccounted).toEqual([]);

		const stale = Object.keys(TESTED_INDIRECTLY).filter(name => hasDedicatedTest(name));
		expect(stale, "These transitions now have direct test coverage — remove them from TESTED_INDIRECTLY").toEqual([]);
	});
});

/**
 * Every wire message type has dedicated test coverage or an audited exemption.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle: if the port passes every test, behavior is identical. A wire message
 * type with no test coverage is a parity gap — the rewrite can change its
 * serialized shape, required fields, or role discriminator, and nothing goes
 * red. This suite derives the wire message type list from the WireMessage union
 * at runtime and asserts each has at least one test file that references it, so
 * adding a new wire message type makes this suite red until someone writes its
 * tests or records an audited exemption.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGES_ROOT = resolve(import.meta.dir, "../..");
const WIRE_SRC = join(import.meta.dir, "..", "src", "index.ts");
const THIS_TEST_NAME = "every-wire-message-has-test-coverage.test.ts";

/** Extract all message type names from the WireMessage union in index.ts. */
function extractWireMessageTypes(): string[] {
	const source = readFileSync(WIRE_SRC, "utf-8");
	const match = source.match(/export type WireMessage =\s*([\s\S]*?);/);
	if (!match) throw new Error("Could not find WireMessage union in index.ts");
	return match[1]
		.split("|")
		.map(t => t.trim())
		.filter(Boolean)
		.sort();
}

/** Recursively collect every .test.ts and .test.tsx file under a root. */
function collectTestFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git" || entry === "target" || entry === "dist") continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				stack.push(full);
			} else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
				out.push(full);
			}
		}
	}
	return out;
}

const ALL_TEST_FILES = collectTestFiles(PACKAGES_ROOT).filter(f => !f.endsWith(THIS_TEST_NAME));
const ALL_TEST_CONTENT = ALL_TEST_FILES.map(f => readFileSync(f, "utf-8")).join("\n");

/**
 * A message type has test coverage if a test file's name matches or if its
 * content references the type name.
 */
function hasTestCoverage(typeName: string): boolean {
	const hyphenated = typeName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
	const hasMatchingFileName = ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		return base.includes(hyphenated) || base.includes(typeName);
	});
	if (hasMatchingFileName) return true;

	return ALL_TEST_CONTENT.includes(typeName);
}

/**
 * Message types tested via cross-package projection/serialization suites or
 * indirect role handling rather than direct type-name references in test files.
 * Each entry names the suite that covers it so the assertion is auditable.
 */
const AUDITED_EXEMPTIONS: Record<string, string> = {
	WireBashExecutionMessage: "session-entry-projection.test.ts tests bashExecution role projection and round-trip",
	WireBranchSummaryMessage: "session-entry-projection.test.ts tests branchSummary role projection and details stripping",
	WireCompactionSummaryMessage: "session-entry-projection.test.ts tests compactionSummary role projection and providerPayload stripping",
	WireFileMentionMessage: "session-entry-projection.test.ts tests fileMention role projection and body stripping",
	WireHookMessage: "session-entry-projection.test.ts tests legacy hookMessage role projection and attribution dropping",
	WirePythonExecutionMessage: "session-entry-projection.test.ts tests pythonExecution role projection and context excluding",
};

describe("every wire message type has test coverage", () => {
	const messageTypes = extractWireMessageTypes();

	it("the WireMessage union defines message types", () => {
		expect(messageTypes.length).toBeGreaterThan(0);
	});

	for (const typeName of messageTypes) {
		it(`message type "${typeName}" has test coverage or an audited exemption`, () => {
			const covered = hasTestCoverage(typeName);
			const exempted = typeName in AUDITED_EXEMPTIONS;
			expect(
				covered || exempted,
				`Wire message type "${typeName}" has no test coverage and no audited exemption. ` +
					"Add a test file referencing it or record an audited exemption in AUDITED_EXEMPTIONS.",
			).toBe(true);
		});
	}

	it("the exemption list is exhaustive for message types without direct test coverage", () => {
		const withoutCoverage = messageTypes.filter(name => !hasTestCoverage(name));
		const unaccounted = withoutCoverage.filter(name => !(name in AUDITED_EXEMPTIONS));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(AUDITED_EXEMPTIONS).filter(name => hasTestCoverage(name));
		expect(stale, "These message types now have direct test coverage — remove them from AUDITED_EXEMPTIONS").toEqual([]);
	});
});

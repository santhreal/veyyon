/**
 * WHY: the terminal renderer is supposed to draw view-models, and a renderer
 * that reads an `AgentMessage` instead of a `TranscriptBlock` is a renderer the
 * browser client cannot be written from. The defect class is a file under
 * `modes/terminal/` that reaches back into `session/` or `@veyyon/agent-core`
 * for one field the view-model does not carry yet — after which the contract
 * exists on paper and the coupling is back.
 *
 * Two files are allowed to see both sides, and only two: the driver, which
 * implements the contract on the engine, and the event bridge, which turns
 * session events into view-model updates. The allowance is pinned by exact
 * equality, so widening it is a recorded decision rather than a quiet one.
 *
 * What it does NOT catch: a view-model field whose value the renderer
 * interprets as though it were a runtime object.
 */

import { describe, expect, test } from "bun:test";
import { importSpecifiers, isDirectory, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

const TERMINAL = repoPath("packages/coding-agent/src/modes/terminal");

/**
 * The files permitted to import both a session and the presentation contract.
 * `event-bridge.ts` lives in `src/presentation/`, so nothing under
 * `modes/terminal/` is on the list today.
 */
const BOTH_SIDES_ALLOWED: readonly string[] = [];

/** Runtime specifiers a renderer must not reach for. */
function isRuntimeImport(specifier: string): boolean {
	if (specifier === "@veyyon/agent-core" || specifier.startsWith("@veyyon/agent-core/")) return true;
	if (specifier === "@veyyon/ai" || specifier.startsWith("@veyyon/ai/")) return true;
	return specifier.includes("session/agent-session") || specifier.includes("/session/");
}

describe("the terminal renderer draws view-models", () => {
	test("the directory exists and holds the driver", () => {
		expect(isDirectory(TERMINAL)).toBe(true);
		const files = typeScriptFiles(TERMINAL).map(repoRelative);
		expect(files).toContain("packages/coding-agent/src/modes/terminal/driver.ts");
	});

	test("only the recorded files import the agent runtime", () => {
		const offenders: string[] = [];
		for (const file of typeScriptFiles(TERMINAL)) {
			if (importSpecifiers(file).some(isRuntimeImport)) offenders.push(repoRelative(file));
		}
		// Exact equality: a new file that needs both sides has to be added here on
		// purpose, and a file that stops needing it has to be removed.
		expect(offenders.sort()).toEqual([...BOTH_SIDES_ALLOWED].sort());
	});

	test("the driver takes its types from the presentation contract", () => {
		const specifiers = importSpecifiers(repoPath("packages/coding-agent/src/modes/terminal/driver.ts"));
		expect(specifiers).toContain("@veyyon/wire/presentation");
		expect(specifiers).toContain("@veyyon/tui");
	});

	test("every module under modes/terminal that renders takes a view-model", () => {
		// A renderer module with no presentation import and no sibling import is
		// either dead or reading something it should not.
		const orphans: string[] = [];
		for (const file of typeScriptFiles(TERMINAL)) {
			const specifiers = importSpecifiers(file);
			const relatesToContract = specifiers.some(
				specifier => specifier === "@veyyon/wire/presentation" || specifier.startsWith("."),
			);
			if (!relatesToContract) orphans.push(repoRelative(file));
		}
		expect(orphans).toEqual([]);
	});
});

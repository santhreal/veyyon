/**
 * The generated-example-twin gate: every `.js` example must be the transpiled
 * form of the `.ts` example beside it.
 *
 * Why this suite exists: the examples ship twice so a plain-JavaScript reader can
 * copy one without stripping types, and both copies were hand-maintained with
 * nothing comparing them. Five had drifted by the time the gate was written.
 * `hooks/git-checkpoint.js` still carried the docblock from before its
 * TypeScript twin was rewritten, and `extensions/pirate.js` and
 * `hooks/file-trigger.js` each reproduced a type error that had just been fixed
 * in the `.ts` copy — `systemPromptAppend`, a field no result type has, and a
 * bare `true` where `sendMessage` takes an options object. A reader who picked
 * the JavaScript file got the broken version of a fix that had already landed.
 *
 * The tests below pin what the gate must and must not claim, then lock the
 * repository itself.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { driftedTwins, EXAMPLES_PACKAGE, type GeneratedTwin, generateTwins } from "./gen-example-js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Transpiling the whole examples project is slow, so it happens once here. */
const twins = generateTwins(REPO_ROOT);

function twin(rel: string): GeneratedTwin {
	const found = twins.find(t => t.rel.endsWith(rel));
	if (!found) throw new Error(`no generated twin matching ${rel}; found ${twins.length} twins`);
	return found;
}

describe("driftedTwins", () => {
	/** THE contract, on synthetic input so the comparison itself is pinned rather
	 *  than inferred from a passing repository. */
	it("reports exactly the twins whose committed text differs", () => {
		const input: GeneratedTwin[] = [
			{ rel: "a.js", generated: "x\n", committed: "x\n" },
			{ rel: "b.js", generated: "x\n", committed: "y\n" },
			{ rel: "c.js", generated: "x\n", committed: undefined },
		];

		expect(driftedTwins(input).map(t => t.rel)).toEqual(["b.js", "c.js"]);
	});

	/** A one-character difference is drift. Whitespace-insensitive comparison was
	 *  how the import-order drift in `handoff.js` stayed invisible. */
	it("treats a whitespace-only difference as drift", () => {
		expect(driftedTwins([{ rel: "a.js", generated: "a\nb\n", committed: "b\na\n" }])).toHaveLength(1);
	});
});

describe("generateTwins", () => {
	/** Guards the guard: a transpile that emitted nothing would make the repo lock
	 *  below pass while comparing zero files. */
	it("pairs every shipped example twin with a fresh transpile", () => {
		expect(twins.length).toBeGreaterThan(25);
		expect(twins.every(t => t.rel.startsWith(`${EXAMPLES_PACKAGE}/examples/`))).toBe(true);
		expect(twins.every(t => t.generated.length > 0)).toBe(true);
	});

	/**
	 * Types are gone and comments are not. The comments ARE the example, so a
	 * generator that stripped them (Bun's transpiler does) would quietly hand the
	 * JavaScript reader a worse file than the TypeScript reader gets.
	 */
	it("erases types and keeps comments", () => {
		const pirate = twin("examples/extensions/pirate.js");

		expect(pirate.generated).not.toContain("ExtensionAPI");
		expect(pirate.generated).toContain("// Append to system prompt when pirate mode is enabled");
	});

	/**
	 * `with-deps/` is a package of its own: its `ms` dependency is deliberately
	 * outside the workspace, so it cannot belong to the workspace examples project
	 * and needs a project of its own. It ships a committed twin, so leaving it out
	 * would make it the one example nothing could regenerate — the same
	 * hand-maintained hole this gate exists to close.
	 */
	it("covers the example that lives in its own package", () => {
		expect(twins.map(t => t.rel)).toContain(`${EXAMPLES_PACKAGE}/examples/extensions/with-deps/index.js`);
		expect(twin("with-deps/index.js").generated).toContain("parse_duration");
	});

	/**
	 * Only examples that ALREADY ship a twin are generated. Emitting a `.js` beside
	 * every `.ts` would add two dozen files nobody asked for, and the gate would
	 * then fail on a tree that is correct.
	 */
	it("writes no twin for an example that ships none", () => {
		const shipped = twins.filter(t => t.committed === undefined);

		expect(shipped).toEqual([]);
		for (const t of twins) {
			expect(fs.existsSync(path.join(REPO_ROOT, t.rel))).toBe(true);
		}
	});

	/**
	 * The specific fixes that the `.js` copies had missed. Asserted on the
	 * generated text, so the assertion holds whichever copy a reader opens.
	 */
	it("carries the fixed API usage into the generated JavaScript", () => {
		expect(twin("examples/extensions/pirate.js").generated).not.toContain("systemPromptAppend");
		expect(twin("examples/extensions/pirate.js").generated).toContain("...event.systemPrompt");
		expect(twin("examples/hooks/file-trigger.js").generated).toContain("{ triggerTurn: true }");
		expect(twin("examples/sdk/07-context-files.js").generated).toContain("await discoverContextFiles()");
	});
});

describe("the repository's own example twins", () => {
	/**
	 * The lock. Seven were stale when the gate was written.
	 *
	 * The timeout belongs on the test, not on `describe`, which takes no timeout
	 * argument: the 120s passed there was accepted at runtime and ignored, so this
	 * check — which regenerates every twin — ran on the default budget.
	 */
	it("ships no stale generated twin", () => {
		expect(driftedTwins(twins).map(t => t.rel)).toEqual([]);
	}, 120_000);
});

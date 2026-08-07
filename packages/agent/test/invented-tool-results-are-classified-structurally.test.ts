import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectPackageSources, PACKAGES_DIR } from "../../utils/test/support/package-sources";
import { loopSource, unionMembers } from "./support/invented-tool-result-sources";

/**
 * Structural lock on one mistake class: classifying a tool result by matching its
 * TEXT instead of a structured discriminator.
 *
 * The loop invents a tool result whenever a call the assistant emitted did not run.
 * Every one of those placeholders builds its headline from a fixed table, so the
 * text is a function of the SOURCE and carries no per-event information: two
 * unrelated interrupts are byte-identical, and 52 in a row is a measured number
 * rather than a hypothetical. Any consumer that reads the bytes to decide what
 * happened therefore sees one failure repeating. `__synthetic` / `__skipped` exist
 * so nobody has to.
 *
 * The class recurs because a mechanism gets applied to the case someone had in mind
 * and not to the long tail: the discriminator was given to two constructors and the
 * third shipped with an empty details bag. So the lock is written to FAIL BY
 * DEFAULT. Every inventory it checks is derived from the source at run time, and a
 * new member of any of them turns this red until a decision for it is recorded
 * here.
 *
 * WHAT IT CATCHES
 *  - A new placeholder constructed inline at an `emitToolResult` call site, which
 *    is how the untagged one got in.
 *  - An existing constructor that stops stamping a discriminator, directly or
 *    through its details factory.
 *  - A new member of any source union, or a renamed constructor.
 *  - Any production file outside the owner that names one of the fixed headlines,
 *    which is the only way to text-classify these: you have to quote the table.
 *
 * WHAT IT CANNOT CATCH
 *  - A consumer that reads `details` and then ignores what it says. Behaviour, not
 *    structure; covered by ./synthetic-tool-results-carry-a-discriminator.test.ts
 *    and coding-agent/test/skipped-tool-results-are-not-refusals.test.ts.
 *  - A text classifier that reconstructs a headline instead of quoting it, or that
 *    matches a loose fragment ("aborted", "skipped") the tables share with real
 *    tool errors.
 *  - Placeholders invented outside `agent-loop.ts`. The provider-side pairing
 *    fillers in `ai/src/providers/transform-messages.ts` are deliberately out of
 *    scope: they are built during the outbound wire transform, are never persisted
 *    to agent state, and the provider payload has no `details` field to carry a
 *    discriminator in.
 *    `coding-agent/src/cursor.ts` `buildToolErrorResult` also ships `details: {}`
 *    for a tool the bridge could not find, but its text names the missing tool, so
 *    two of them never collide and no consumer counts repeats of it. It is recorded
 *    here rather than fixed: giving it a discriminator means inventing a third
 *    concept for one call site, and this lock cannot see it from `packages/agent`.
 */

const LOOP_REL = "agent/src/agent-loop.ts";

/**
 * Split the argument list of the call whose `(` is at `open`, respecting nesting.
 * Precise about the only thing the lock reads: which expression each argument
 * starts with.
 */
function callArguments(source: string, open: number): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = open + 1;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) {
				args.push(source.slice(start, i));
				return args;
			}
		} else if (ch === "," && depth === 1) {
			args.push(source.slice(start, i));
			start = i + 1;
		}
	}
	return args;
}

/** Body of `function <name>(`, from its opening brace to the matching close. */
function functionBody(source: string, name: string): string | undefined {
	const decl = source.indexOf(`function ${name}(`);
	if (decl === -1) return undefined;
	const open = source.indexOf("{", source.indexOf(")", decl));
	if (open === -1) return undefined;
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
	}
	return undefined;
}

/**
 * A constructor's body plus the bodies of any local function it calls.
 *
 * `createAbortedToolResult` does not write `__synthetic` itself; it delegates to
 * `syntheticDetailsFor`. Reading only the direct body would have made this lock
 * demand a spelling the code has no reason to use, so it follows one level. One is
 * enough for the shape here and keeps the failure legible.
 */
function effectiveBody(source: string, name: string): string | undefined {
	const body = functionBody(source, name);
	if (body === undefined) return undefined;
	let combined = body;
	for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\(/g)) {
		const callee = functionBody(source, match[1]);
		if (callee !== undefined) combined += callee;
	}
	return combined;
}

describe("invented tool results are classified structurally", () => {
	/**
	 * Every constructor of a result the tool did not return, and the discriminator
	 * key it owes. `createAbortedToolResult` pushes its own stream events rather
	 * than going through `emitToolResult`, so the call-site check below cannot see
	 * it; it is named here instead.
	 */
	const CONSTRUCTORS: Readonly<Record<string, string>> = {
		createAbortedToolResult: "__synthetic",
		createSkippedToolResult: "__skipped",
		createToolSignalAbortedResult: "__skipped",
	};

	it("every constructor of a non-executed tool result stamps its discriminator", async () => {
		const source = await loopSource();
		const missing: string[] = [];
		for (const [name, discriminator] of Object.entries(CONSTRUCTORS)) {
			const body = effectiveBody(source, name);
			if (body === undefined) {
				missing.push(`${name}: not found (renamed? then update this lock)`);
				continue;
			}
			if (!body.includes(`${discriminator}:`)) missing.push(`${name}: no ${discriminator} in its result details`);
		}
		expect(missing).toEqual([]);
	});

	/**
	 * Inline results at an `emitToolResult` site, each declared by the expression
	 * that supplies its text.
	 *
	 * All three are exonerated rather than tolerated, and for one reason: their text
	 * is derived from the actual cause, so two of them are only byte-identical when
	 * the same thing really did happen twice. That is the property the fixed
	 * headlines lack, and it is what makes them safe for a consumer to compare. They
	 * are also correctly classified as refusals: an argument the schema rejected IS
	 * a verdict on the payload.
	 *
	 * A fourth inline site matches nothing here and turns this red, which is the
	 * point: the untagged placeholder got in as an inline literal nobody had to
	 * justify.
	 */
	const INLINE_RESULT_SITES: Readonly<Record<string, string>> = {
		errorText: "argument repair gave up; the text is the repairer's own reason",
		"errorMessage(validationError)": "schema validation refused the payload",
		"errorMessage(transformError)": "the argument transform threw",
	};

	it("no tool result is invented inline at an emitToolResult call site without a recorded reason", async () => {
		const source = await loopSource();
		const allowed = new Set(["result", ...Object.keys(CONSTRUCTORS)]);
		const offenders: string[] = [];
		const inlineSeen: string[] = [];
		let sites = 0;
		for (let at = source.indexOf("emitToolResult("); at !== -1; at = source.indexOf("emitToolResult(", at + 1)) {
			if (/[\w$]/.test(source[at - 1] ?? "")) continue;
			const args = callArguments(source, at + "emitToolResult".length);
			if (args.length < 2) continue;
			sites++;
			const head = args[1].trim();
			if (head.startsWith("{")) {
				const declared = Object.keys(INLINE_RESULT_SITES).filter(marker => head.includes(marker));
				if (declared.length === 1) inlineSeen.push(declared[0]);
				else offenders.push(`inline result with no recorded reason: ${head.split("\n")[0]}`);
				continue;
			}
			const name = /^[A-Za-z_$][\w$]*/.exec(head)?.[0];
			if (name === undefined || !allowed.has(name)) offenders.push(head.split("\n")[0]);
		}
		// The scan has to have found the call sites for its silence to mean anything.
		expect(sites).toBeGreaterThanOrEqual(7);
		expect(offenders).toEqual([]);
		// Exactly the declared set, each exactly once: a removed site is as much a
		// signal as an added one, because it means this reasoning is now stale.
		expect(inlineSeen.sort()).toEqual(Object.keys(INLINE_RESULT_SITES).sort());
	});

	/**
	 * The source unions, read out of the source at run time. Adding a skip reason or
	 * an assistant-stop source without deciding what it means here is the exact
	 * shape of the original defect, so it fails until a decision is recorded.
	 *
	 * The recorded decision is the mapping each constructor performs. Both tables
	 * are checked against the declared unions in both directions, so neither an
	 * unmapped member nor a mapping to a member that no longer exists survives.
	 */
	it("every declared skip source is mapped to a details source", async () => {
		const source = await loopSource();
		const declared = await unionMembers(source, "SkippedToolResultDetails", "source");
		// `createSkippedToolResult` takes the interrupt source and defaults an absent
		// one; the details union is therefore the input union plus that default.
		const mapped = ["user", "system", "unknown", "irc", "cancelled-run", "steering"];
		expect(declared.slice().sort()).toEqual(mapped.slice().sort());
	});

	it("every declared assistant stop reason is mapped to a synthetic source", async () => {
		const source = await loopSource();
		const declared = await unionMembers(source, "SyntheticToolResultDetails", "source");
		const reasons = await unionMembers(source, "createAbortedToolResult", "reason");
		const mapped: Readonly<Record<string, string>> = {
			aborted: "assistant_stop_aborted",
			error: "assistant_stop_error",
			skipped: "assistant_stop_skipped",
			length: "assistant_stop_length",
		};
		// Every reason the constructor accepts has a decision, and every source it
		// can stamp is produced by one of them. A fifth reason, or a fifth source,
		// is red until it appears here.
		expect(reasons.slice().sort()).toEqual(Object.keys(mapped).sort());
		expect(declared.slice().sort()).toEqual(Object.values(mapped).sort());
	});

	/**
	 * The consumer half. A headline is a function of the source, so quoting one is
	 * always an attempt to recover a classification that `details` already states
	 * exactly. `agent-loop.ts` writes them and is the only file allowed to name
	 * them.
	 */
	const HEADLINES: readonly string[] = [
		"Skipped due to ",
		"Do not count this skipped result",
		"Tool execution was aborted",
		"Tool call was not executed because",
		"Tool was not executed because the run was aborted",
	];

	it("no production source outside the loop matches on a placeholder headline", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === LOOP_REL) continue;
			// Comments are stripped so a doc comment that explains why the
			// discriminator exists is not itself an offender.
			const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
			for (const headline of HEADLINES) {
				if (code.includes(headline)) offenders.push(`${rel}: ${headline.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("reads the loop from the path this lock names", async () => {
		// A wrong path would make every scan above silently vacuous.
		await expect(fs.stat(path.join(PACKAGES_DIR, LOOP_REL))).resolves.toBeDefined();
	});
});

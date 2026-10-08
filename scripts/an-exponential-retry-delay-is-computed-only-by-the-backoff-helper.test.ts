/**
 * An exponential retry delay is computed in one place: `exponentialBackoffDelay` in
 * `packages/utils/src/backoff.ts`.
 *
 * WHY THIS SUITE EXISTS. Retry loops across `ai`, `coding-agent`, `mnemopi`, `kernel` and `utils`
 * each wrote `base * 2 ** attempt` themselves, with their own ceiling and their own jitter, so two
 * loops retrying the same class of failure waited for different times and only some of them spread
 * their retries. The helper states the schedule once: base, doubling, ceiling, jitter. This sweep
 * reads the shipped source of every workspace member and fails on a doubling written anywhere else.
 *
 * THE CLASS is a delay that doubles per step. It has four spellings, and each is a rule below:
 *   - `2 ** n` with a non-constant exponent;
 *   - `Math.pow(2, n)` with a non-constant exponent;
 *   - `k << n` with a numeric `k` and a non-constant shift;
 *   - a value whose name reads as a delay multiplied by two (`backoffMs * 2`, `delay *= 2`), which
 *     is the stateful spelling of the same schedule.
 * A match that is not a delay is recorded in {@link NOT_A_DELAY} with its reason, pinned by exact
 * equality, so a new match fails until someone routes it through the helper or records why it is
 * not a delay, and a recorded match that disappears fails until its row is deleted.
 *
 * WHAT THIS DOES NOT CATCH. A schedule that grows by a factor other than two (`1.5 ** attempt`), a
 * shift of a base that is not a numeric literal (`base << attempt`), a doubling of a value whose name
 * does not read as a delay, and a precomputed table of delays (`[500, 1000, 2000]`). Test files are
 * not swept: a test that restates the schedule to assert it is reading the helper, not replacing it.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { collectSourceFiles, REPO_ROOT, typeScriptMembers, typeScriptMemberTopLevels } from "./workspace-layout";

/** The one file allowed to double a delay. */
const OWNER = "packages/utils/src/backoff.ts";

/**
 * Matches that double something other than a delay, keyed `<file>: <expression>`. May shrink; a new
 * row needs a reason a reviewer can check against the expression.
 */
const NOT_A_DELAY: Readonly<Record<string, string>> = {
	"plugins/mnemopi/src/core/binary-vectors.ts: 0xff << (BITS_PER_BYTE - remainingBits)":
		"masks the valid high bits of a packed binary vector's last byte",
	"plugins/mnemopi/src/core/binary-vectors.ts: 1 << (7 - (i & 7))": "sets one bit of a packed binary vector",
};

/** A name that reads as a time to wait. Matched against the last segment of the doubled operand. */
const DELAY_NAME = /delay|backoff|cooldown|wait|sleep/i;

/**
 * Cheap text filter run before parsing: every rule needs a literal `2` beside `*`, a `Math.pow`, or a
 * `<<`. A file without one cannot match, and skipping it keeps the sweep from parsing the tree.
 */
const MAY_DOUBLE = /(?<![\w.])2\s*\*|\*=?\s*2(?![\w.])|Math\.pow\s*\(|<</;

type Rule = "power-of-two" | "math-pow" | "shift" | "doubled-delay";

interface Finding {
	readonly rule: Rule;
	readonly text: string;
}

function unwrap(node: Node): Node {
	let current = node;
	while (Node.isParenthesizedExpression(current)) current = current.getExpression();
	return current;
}

function isNumber(node: Node, value?: number): boolean {
	const bare = unwrap(node);
	if (Node.isNumericLiteral(bare)) return value === undefined || bare.getLiteralValue() === value;
	if (value === undefined && Node.isPrefixUnaryExpression(bare)) return isNumber(bare.getOperand());
	return false;
}

/** The name a doubled operand reads as: an identifier, or the last segment of a property access. */
function operandName(node: Node): string | undefined {
	const bare = unwrap(node);
	if (Node.isIdentifier(bare)) return bare.getText();
	if (Node.isPropertyAccessExpression(bare)) return bare.getName();
	return undefined;
}

function isDelayOperand(node: Node): boolean {
	const name = operandName(node);
	return name !== undefined && DELAY_NAME.test(name);
}

/** Every doubling in `source`, by rule. Exported shape is the finding list the suite compares. */
function findDoublings(project: Project, source: string): Finding[] {
	const file = project.createSourceFile("probe.ts", source, { overwrite: true });
	const findings: Finding[] = [];
	const record = (rule: Rule, node: Node): void => {
		findings.push({ rule, text: node.getText().replace(/\s+/g, " ") });
	};
	file.forEachDescendant(node => {
		if (Node.isBinaryExpression(node)) {
			const operator = node.getOperatorToken().getKind();
			const left = node.getLeft();
			const right = node.getRight();
			if (operator === SyntaxKind.AsteriskAsteriskToken && isNumber(left, 2) && !isNumber(right)) {
				record("power-of-two", node);
			} else if (operator === SyntaxKind.LessThanLessThanToken && isNumber(left) && !isNumber(right)) {
				record("shift", node);
			} else if (
				(operator === SyntaxKind.AsteriskToken || operator === SyntaxKind.AsteriskEqualsToken) &&
				((isNumber(right, 2) && isDelayOperand(left)) || (isNumber(left, 2) && isDelayOperand(right)))
			) {
				record("doubled-delay", node);
			}
			return;
		}
		if (Node.isCallExpression(node) && node.getExpression().getText() === "Math.pow") {
			const [base, exponent] = node.getArguments();
			if (base !== undefined && exponent !== undefined && isNumber(base, 2) && !isNumber(exponent)) {
				record("math-pow", node);
			}
		}
	});
	project.removeSourceFile(file);
	return findings;
}

interface Sweep {
	readonly scanned: string[];
	/** `<file>: <expression>` for every match outside the owner. */
	readonly outside: string[];
	/** Matches inside the owner, which prove the sweep reads the schedule it protects. */
	readonly inOwner: Finding[];
}

function sweep(): Sweep {
	const project = new Project({ useInMemoryFileSystem: true });
	const scanned = collectSourceFiles(typeScriptMembers(), REPO_ROOT)
		.map(file => path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"))
		.sort();
	const outside: string[] = [];
	const inOwner: Finding[] = [];
	for (const rel of scanned) {
		const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
		if (!MAY_DOUBLE.test(source)) continue;
		const findings = findDoublings(project, source);
		if (rel === OWNER) inOwner.push(...findings);
		else for (const finding of findings) outside.push(`${rel}: ${finding.text}`);
	}
	return { scanned, outside: outside.sort(), inOwner };
}

describe("an exponential retry delay is computed only by the backoff helper", () => {
	const result = sweep();

	it("reads every tree that holds a TypeScript member", () => {
		expect(result.scanned.length).toBeGreaterThan(1000);
		const roots = new Set(result.scanned.map(rel => rel.split("/")[0]));
		const withSource = typeScriptMemberTopLevels().filter(root =>
			typeScriptMembers().some(
				member => member.startsWith(`${root}/`) && fs.existsSync(path.join(REPO_ROOT, member, "src")),
			),
		);
		expect(withSource.filter(root => !roots.has(root))).toEqual([]);
	});

	it("finds the schedule inside the helper, so a green sweep is a sweep that can see one", () => {
		expect(result.scanned).toContain(OWNER);
		expect(result.inOwner.map(finding => finding.rule)).toContain("power-of-two");
	});

	it("finds no doubling outside the helper that is not recorded as something other than a delay", () => {
		const unrecorded = result.outside.filter(key => !(key in NOT_A_DELAY));
		expect(
			unrecorded,
			`Route these through exponentialBackoffDelay from @veyyon/utils/backoff, or record in NOT_A_DELAY why the value is not a delay:\n${unrecorded.join("\n")}`,
		).toEqual([]);
	});

	it("keeps no stale NOT_A_DELAY row", () => {
		const found = new Set(result.outside);
		expect(Object.keys(NOT_A_DELAY).filter(key => !found.has(key))).toEqual([]);
	});
});

describe("what counts as a doubling", () => {
	const project = new Project({ useInMemoryFileSystem: true });
	const rules = (source: string): Rule[] => findDoublings(project, source).map(finding => finding.rule);

	it("matches each spelling of a per-step doubling", () => {
		expect(rules("const d = base * 2 ** attempt;")).toEqual(["power-of-two"]);
		expect(rules("const d = base * 2 ** (attempt - 1);")).toEqual(["power-of-two"]);
		expect(rules("const d = base * Math.pow(2, state.attempt);")).toEqual(["math-pow"]);
		expect(rules("const d = 1000 << attempt;")).toEqual(["shift"]);
		expect(rules("backoffMs = Math.min(MAX, backoffMs * 2);")).toEqual(["doubled-delay"]);
		expect(rules("this.#retryDelay *= 2;")).toEqual(["doubled-delay"]);
		expect(rules("const next = 2 * waitMs;")).toEqual(["doubled-delay"]);
	});

	it("leaves constants, other bases and values that are not delays alone", () => {
		expect(rules("const keepalive = 2 ** 30;")).toEqual([]);
		expect(rules("const eased = (1 - t) ** 2;")).toEqual([]);
		expect(rules("const width = paddingX * 2;")).toEqual([]);
		expect(rules("const mask = 1 << 20;")).toEqual([]);
		expect(rules("// base * 2 ** attempt\nconst s = 'delay * 2';")).toEqual([]);
	});
});

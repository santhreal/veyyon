/**
 * No prompt tells the agent it holds a permission the user never gave it.
 *
 * WHY THIS SUITE EXISTS. `execution-workflow/commit-often` shipped this to every session that
 * had a bash tool: "You do NOT need permission to commit your own work, and you NEVER wait for
 * the user to ask. Frequent small commits are the expected default, not an escalation." The
 * subagent orchestrator notice carried the same two sentences. Whether committing without being
 * asked is the behaviour a user wants is that user's call to make about their own repository, and
 * a prompt cannot make it for them; stating it as a permission the agent already holds also
 * generalises past the one command it was written for, because an agent that has been told it
 * needs no permission for one class of git command reads that as the register the rest of git is
 * discussed in. The instruction to land each green chunk as a commit stayed. The entitlement left.
 *
 * WHAT THIS CLOSES, which is the reason it is a sweep and not two string assertions. Deleting
 * those sentences fixes the two files that had them. It does nothing about the next statement or
 * the next prompt, and the registries hold hundreds of rows across four packages. So this
 * enumerates every prompt the product can send — every statement row, and every row of every
 * prompt registry — from the registries themselves at run time, and matches each against the
 * grant idioms. A row added tomorrow is swept the day it is added, and a registry that stops
 * enumerating cannot pass this vacuously: the corpus size is asserted too.
 *
 * WHAT IT DOES NOT CATCH. It reads idioms, not intent: "commit whenever you like" is a grant no
 * pattern here matches, and a prompt is free to grant a permission in words nobody has used yet.
 * It also only reads model-visible bytes, so a `purpose` string in the statement registry (which
 * documents a row for a reader and never reaches a model) is out of scope by design. And the
 * "without asking the user" pattern reads as a grant regardless of the sentence around it, so a
 * PROHIBITION phrased that way trips it; the fix is the phrasing the destructive-git bullet
 * already uses, "without the user asking", which is why that exact sentence is a control below.
 */
import { describe, expect, it } from "bun:test";
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { codingAgentPrompts } from "@veyyon/coding-agent/prompts/registry";
import { PROMPT_STATEMENTS } from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import type { PromptRegistryView } from "@veyyon/utils";

interface GrantPattern {
	/** What the phrasing claims, for the failure message. */
	readonly claim: string;
	readonly re: RegExp;
}

/**
 * Each entry matches only phrasings that GRANT. A prohibition is written "NEVER x without the
 * user asking" here and in the prompt files, and none of these match that shape.
 */
const GRANTS: readonly GrantPattern[] = [
	{
		claim: "says permission is not needed",
		re: /\b(?:do(?:es)?|did)\s+not\s+need\s+permission\b|\bdon'?t\s+need\s+permission\b|\bneeds?\s+no\s+permission\b|\bno\s+permission\s+(?:is\s+)?(?:needed|required)\b/i,
	},
	{
		claim: "says the agent never waits to be asked",
		re: /\bnever\s+wait(?:s|ing)?\s+(?:for\s+(?:the\s+user|permission|approval)|to\s+be\s+asked)\b/i,
	},
	{
		claim: "says there is no need to ask",
		re: /\bno\s+need\s+to\s+ask\b|\bwithout\s+(?:having\s+to\s+)?ask(?:ing)?\s+(?:the\s+user|first|permission)\b/i,
	},
	{
		claim: "frames acting unasked as the default rather than an escalation",
		re: /\bnot\s+an\s+escalation\b/i,
	},
];

/** Every grant a text carries, as `<claim>` strings, in pattern order. */
const grantsIn = (text: string): string[] => GRANTS.filter(grant => grant.re.test(text)).map(grant => grant.claim);

const REGISTRIES: readonly (readonly [string, PromptRegistryView])[] = [
	["coding-agent", codingAgentPrompts],
	["agent-core", agentCorePrompts],
	["ai", aiPrompts],
	["hashline", hashlinePrompts],
];

/** The two shapes the scan reads, so a synthetic corpus can exercise the same code the sweep runs. */
interface ScannedStatement {
	readonly id: string;
	readonly text: string;
}
interface ScannedRegistry {
	readonly ids: readonly string[];
	require(id: string): { readonly text: string };
}

/** `<surface>:<id> — <claim>` for every grant in the given corpus, sorted. */
const scan = (
	statements: readonly ScannedStatement[],
	registries: readonly (readonly [string, ScannedRegistry])[],
): string[] => {
	const found: string[] = [];
	for (const statement of statements) {
		for (const claim of grantsIn(statement.text)) found.push(`statement:${statement.id} — ${claim}`);
	}
	for (const [surface, registry] of registries) {
		for (const id of registry.ids) {
			for (const claim of grantsIn(registry.require(id).text)) found.push(`${surface}:${id} — ${claim}`);
		}
	}
	return found.sort();
};

/** Every grant in every prompt the product can send. */
const offenders = (): string[] => scan(PROMPT_STATEMENTS, REGISTRIES);

/** One sentence that carries exactly one grant, for the per-surface mechanism tests. */
const GRANT_SENTENCE = "You do NOT need permission to commit your own work.";

describe("the prompts the product ships", () => {
	/**
	 * The gate. A new statement or prompt that claims a permission fails here naming the row, and
	 * the exact-equality empty array is the opt-out mechanism: recording a decision means writing
	 * the row into this expectation, one entry at a time, where a reviewer sees it.
	 */
	it("grant the agent no permission the user did not give", () => {
		expect(offenders()).toEqual([]);
	});

	/**
	 * The corpus guard. Every assertion above is over an enumeration, so an import that starts
	 * resolving to an empty registry would turn this suite green while checking nothing. These are
	 * the counts at the time of writing, asserted as lower bounds because rows get added.
	 */
	it("are all reachable through the registries this reads", () => {
		expect(PROMPT_STATEMENTS.length).toBeGreaterThan(40);
		expect(REGISTRIES.map(([surface]) => surface)).toEqual(["coding-agent", "agent-core", "ai", "hashline"]);
		const sizes = REGISTRIES.map(([surface, registry]) => [surface, registry.ids.length] as const);
		expect(sizes.every(([, count]) => count > 0)).toBe(true);
		expect(codingAgentPrompts.ids.length).toBeGreaterThan(100);
		const empty = REGISTRIES.flatMap(([surface, registry]) =>
			registry.ids.filter(id => registry.require(id).text.trim() === "").map(id => `${surface}:${id}`),
		);
		expect(empty).toEqual([]);
		expect(
			PROMPT_STATEMENTS.filter(statement => statement.text.trim() === "").map(statement => statement.id),
		).toEqual([]);
	});

	/**
	 * The mechanism, pinned per surface. The gate above is over a corpus that is clean, so on its
	 * own it stays green if the scan stops reading one of the two kinds of prompt entirely — which
	 * is exactly the mutation that survived when this suite was first gated. These feed the same
	 * scan a synthetic corpus carrying one known grant per surface, so deleting either loop turns
	 * the suite red without waiting for a real prompt to reacquire the defect.
	 */
	it("report a grant in a statement row", () => {
		expect(scan([{ id: "execution-workflow/example", text: GRANT_SENTENCE }], [])).toEqual([
			"statement:execution-workflow/example — says permission is not needed",
		]);
	});

	it("report a grant in a prompt registry row", () => {
		const registry: ScannedRegistry = {
			ids: ["subagent/example"],
			require: () => ({ text: GRANT_SENTENCE }),
		};
		expect(scan([], [["example-package", registry]])).toEqual([
			"example-package:subagent/example — says permission is not needed",
		]);
	});
});

describe("the detector", () => {
	/**
	 * The positive controls ARE the two sentences that were removed, byte for byte, so the
	 * patterns cannot be loosened into uselessness while the sweep above stays green. Each names
	 * the claims it must produce, which also pins every pattern to a real example: a pattern that
	 * matches nothing here is a pattern nobody can show a case for.
	 */
	const REMOVED: readonly (readonly [string, string, string[]])[] = [
		[
			"execution-workflow/commit-often, as it shipped",
			"- Commit often. A green, self-contained unit of work is a commit: stage the paths you touched and commit with a focused message. You do NOT need permission to commit your own work, and you NEVER wait for the user to ask. Frequent small commits are the expected default, not an escalation.",
			[
				"says permission is not needed",
				"says the agent never waits to be asked",
				"frames acting unasked as the default rather than an escalation",
			],
		],
		[
			"the orchestrator notice, as it shipped",
			"6. **Commit each green phase.** Stage the paths the phase touched and commit with a focused message as soon as its gates pass. You do NOT need permission to commit your own work and you NEVER wait to be asked; frequent small commits are the default.",
			["says permission is not needed", "says the agent never waits to be asked"],
		],
		[
			"a grant phrased as no need to ask",
			"You may stage and commit without asking the user, and there is no need to ask first.",
			["says there is no need to ask"],
		],
	];

	for (const [name, text, claims] of REMOVED) {
		it(`catches ${name}`, () => {
			expect(grantsIn(text)).toEqual(claims);
		});
	}

	/**
	 * The negative controls. A prohibition, an instruction to ask, and the replacement text all
	 * have to read clean, or the gate above is a gate on the word "permission" and the next author
	 * routes around it by deleting a rule instead of rewording a claim.
	 */
	const CLEAN: readonly (readonly [string, string])[] = [
		[
			"the destructive-git prohibition",
			"- NEVER push, force-push, revert, reset --hard, checkout over changes, clean, drop a stash, or delete a branch without the user asking. Committing is additive; those are destructive and are not.",
		],
		[
			"the replacement commit instruction",
			"- Land each logical chunk as its own commit once its gate is green, rather than accumulating one large uncommitted tree. Stage the paths you touched and write a message scoped to that change.",
		],
		["the ask-first instruction", "- Ask before destructive commands or deleting code you didn't write."],
		[
			"a rule that requires permission",
			"Destructive Git is still prohibited without explicit per-action permission, and pushing never becomes a reason to reach for it.",
		],
		[
			"an escalation rule that is about pushing back",
			"Push back when the plan hides risk or a claim is wrong: name the risk, show evidence, propose the alternative.",
		],
	];

	for (const [name, text] of CLEAN) {
		it(`leaves ${name} alone`, () => {
			expect(grantsIn(text)).toEqual([]);
		});
	}
});

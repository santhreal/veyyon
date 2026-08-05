#!/usr/bin/env bun
// Refuses to let a binary be built while a load-bearing operator contract is broken.
//
// WHY THIS EXISTS. The suite has ~26,000 tests and roughly 31 of them are red on a
// normal day, so red stopped being a signal: a new break hides inside the noise and
// every rebuild became a coin flip. Worse, the suites guarding the contracts that
// matter most were asserting SHAPE rather than behavior, so a total failure passed.
// The clearest case: AGENTS.md loading was 100% dead for every spawned agent while
// `system-prompt-profile-context.test.ts` stayed green, because it asserts that
// profile CONFIGURATION PATHS render and never that the operator's file CONTENT
// reaches the prompt.
//
// So this is deliberately NOT another broad suite. It is a short, fast list of
// contracts whose failure means the product is broken for the operator, run as a
// precondition of building. Small enough that it always runs, specific enough that a
// failure names what the user will notice.
//
// Adding an entry is a claim: "if this breaks, do not ship a binary." Keep it true.
// Nothing goes on this list unless a failure is operator-visible, and every entry
// names the symptom so a future reader can judge whether it still earns its slot.

import { spawn } from "node:child_process";
import * as path from "node:path";

interface Contract {
	/** Test file, relative to the repo root. */
	readonly suite: string;
	/** What the operator loses when this fails. Stated as a symptom, not a mechanism. */
	readonly symptom: string;
}

// Ordered cheapest-first so an obvious break reports in seconds.
const CONTRACTS: readonly Contract[] = [
	{
		// The one addition this list earned today, and it is not a code contract: it is the
		// contract that BUILDING is safe. Every entry below runs `bun test`, and a test run is
		// the thing that already put three rows into the operator's real credential store. If
		// the sandbox gate stops detecting, the next run of this very script is what does the
		// damage, so it goes first and it goes above the suites it protects.
		suite: "scripts/tests-never-touch-real-home.test.ts",
		symptom:
			"a test run reaches the operator's real home: their credentials, profiles and sessions can be overwritten, or their ~/.env read, by the build itself",
	},
	{
		// The runtime half of the entry above, and the more severe of the two. The gate DETECTS
		// a violation someone wrote down; this is the mechanism that REFUSES the write when it
		// happens, through node:fs and through bun:sqlite, in every test process. The original
		// damage went through SQLite's native file handling and touched no JS `fs` call, so a
		// tripwire that only wrapped `fs` would have watched the exact write it exists to stop.
		// It predates today and was left unguarded on that basis; today's measurement (a test
		// reading the operator's ~/.env) is the argument for guarding it anyway.
		suite: "packages/utils/test/real-data-tripwire.test.ts",
		symptom:
			"the guard that REFUSES writes into the operator's real ~/.veyyon has stopped working, so the next test run can overwrite a live OAuth credential with nothing reporting it",
	},
	{
		suite: "packages/coding-agent/test/core/prompt-registry-coverage.test.ts",
		symptom: "a prompt shipped on disk is not registered, so a feature silently renders nothing",
	},
	{
		// The operator ordered these three prompts replaced with oh-my-pi's byte for byte,
		// on the measurement that upstream scores higher on their long-run evals. Prompt
		// text is the least visible thing in the tree: nothing type-checks it, nothing
		// crashes, and an edit shows up only as worse summaries several sessions later.
		// The suite pins each prompt by SHA-256, so an edit is a build failure instead.
		// A deliberate, operator-approved prompt change updates the digest in the same
		// commit; that friction is the point.
		suite: "packages/agent/test/compaction-strategy-contracts.test.ts",
		symptom:
			"a compaction prompt drifted from the upstream text the operator ordered, so summary quality changes with no visible cause",
	},
	{
		// The approval rung an operator gets when they have configured nothing moved to
		// `auto` today, and the four literals that used to decide it separately were
		// collapsed onto one constant. Both directions of a regression here are silent
		// and immediate: land back on `ask` and a fresh install prompts on every tool
		// call, or let a typo normalize upward and a misspelled `approvalMode` runs
		// unattended instead of failing closed. The suite asserts the resolved rung
		// through an empty loader and the real resolver rather than reading the
		// constant back, so it fails on the behaviour and not on its own definition;
		// verified by mutation, and it costs 0.3s.
		suite: "packages/coding-agent/test/tools/approval-default-mode.test.ts",
		symptom:
			"a fresh install asks before every tool call, or a misspelled approvalMode is promoted to unattended instead of failing closed to ask",
	},
	{
		suite: "packages/coding-agent/test/context-files-scope-resolution.test.ts",
		symptom: "the operator's global, profile, or project AGENTS.md does not reach the prompt",
	},
	{
		suite: "packages/coding-agent/test/context-files-agent-type-parity.test.ts",
		symptom: "a spawned subagent runs without the standing instructions its parent has",
	},
	{
		suite: "packages/coding-agent/test/context-files-scope-failures.test.ts",
		symptom: "an unreadable or odd context file silently drops a scope instead of reporting it",
	},
	{
		suite: "packages/coding-agent/test/system-prompt-context-files.test.ts",
		symptom: "the assembled system prompt omits context files the session resolved",
	},
	{
		// Nothing else on this list covers PER-PROFILE isolation, and it is the class that
		// cost the operator every AGENTS.md in every spawned agent: five separate sources
		// each resolved the process-active profile on their own, so a session rooted in
		// another agent dir ran on the booted profile's instructions, skills, plugins and
		// agent definitions. An agent definition carries a system prompt and a tool list,
		// so the worst case is not a missing file, it is a spawned agent that is quietly a
		// different agent than the one asked for.
		suite: "packages/coding-agent/test/two-profile-layer-isolation.test.ts",
		symptom:
			"a session rooted in one profile silently receives another profile's instructions, skills, plugins or agent definitions",
	},
	{
		suite: "packages/coding-agent/test/agent-session-handoff.test.ts",
		symptom: "compaction or handoff loses the model-authored summary, or fabricates one from raw messages",
	},
	{
		suite: "packages/coding-agent/test/legacy-continuity-transcript.test.ts",
		symptom: "an existing session transcript can no longer be loaded",
	},
	{
		suite: "packages/coding-agent/test/modes/components/settings-layout.test.ts",
		symptom: "a settings group is unreachable in /settings, so its settings cannot be changed",
	},
];

const repoRoot = path.dirname(import.meta.dir);

function runSuite(suite: string): Promise<{ ok: boolean; output: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; output: string }>();
	const child = spawn("bun", ["test", suite], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout?.on("data", chunk => {
		output += String(chunk);
	});
	child.stderr?.on("data", chunk => {
		output += String(chunk);
	});
	child.on("close", code => resolve({ ok: code === 0, output }));
	return promise;
}

/** Pull the failing test names out of bun's output so the report names behavior, not exit codes. */
function failureLines(output: string): string[] {
	return output
		.split("\n")
		.filter(line => line.startsWith("(fail)"))
		.map(line => line.trim());
}

async function main(): Promise<void> {
	const broken: Array<{ contract: Contract; failures: string[] }> = [];

	for (const contract of CONTRACTS) {
		const { ok, output } = await runSuite(contract.suite);
		if (ok) {
			console.log(`  ok    ${contract.suite}`);
			continue;
		}
		const failures = failureLines(output);
		broken.push({ contract, failures });
		console.log(`  FAIL  ${contract.suite}`);
	}

	if (broken.length === 0) {
		console.log(`\npreflight: ${CONTRACTS.length} operator contracts hold.`);
		return;
	}

	console.error(`\npreflight FAILED: ${broken.length} of ${CONTRACTS.length} operator contracts are broken.`);
	for (const { contract, failures } of broken) {
		console.error(`\n${contract.suite}`);
		console.error(`  the operator loses: ${contract.symptom}`);
		for (const failure of failures) console.error(`  ${failure}`);
	}
	console.error(
		"\nNo binary is built while these are red. Fix the contract, or if the contract itself is wrong,\n" +
			"change it deliberately in scripts/preflight.ts and say why in the same change.",
	);
	process.exit(1);
}

await main();

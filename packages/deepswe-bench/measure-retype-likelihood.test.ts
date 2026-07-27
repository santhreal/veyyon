/**
 * The instrument that checks argot's central guess against what an agent wrote.
 *
 * WHY THIS SUITE EXISTS. The generator ranks candidates by how many FILES of a
 * repository a string appears in, and then a budget truncates the table. That is a
 * claim about the corpus standing in for a claim about the agent, and if the
 * instrument checking it is wrong nobody finds out: a wrong rank agreement or a
 * wrong emission count reads exactly like a real result.
 *
 * Two things are pinned. The rank-agreement statistic, over cases whose answer is
 * known by hand: a ranking that agrees perfectly, one that is exactly inverted, one
 * with no information, and the tie handling, which is the part that decides whether
 * the eighteen never-emitted handles in a real run drag the score down or are
 * treated as the absence of evidence they are. And the end-to-end measurement over
 * a real generated dictionary and a real transcript file, so the attribution by
 * working directory and the emission counting are exercised together rather than
 * described.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { measureRetype, rankAgreement } from "./measure-retype-likelihood";

describe("rank agreement", () => {
	test("a ranking that matches the observed order scores 1", () => {
		// The definition anchor. Rank 0 emitted most, rank 2 least.
		expect(
			rankAgreement([
				{ rank: 0, emitted: 30 },
				{ rank: 1, emitted: 20 },
				{ rank: 2, emitted: 10 },
			]),
		).toBe(1);
	});

	test("an exactly inverted ranking scores -1", () => {
		// The value that says the generator is not merely uninformative but actively
		// wrong, which is the outcome the whole ARGOT-RETYPE-LIKELIHOOD row is about.
		expect(
			rankAgreement([
				{ rank: 0, emitted: 10 },
				{ rank: 1, emitted: 20 },
				{ rank: 2, emitted: 30 },
			]),
		).toBe(-1);
	});

	test("a ranking with as many agreements as disagreements scores 0", () => {
		// Chance. Asserted so a statistic that quietly favoured agreement (say by
		// counting ties as concordant) could not report a positive result for a
		// ranking that carries no information.
		expect(
			// Three concordant pairs and three discordant ones, by hand: (0,1) (0,3)
			// and (2,3) agree, (0,2) (1,2) and (1,3) do not.
			rankAgreement([
				{ rank: 0, emitted: 30 },
				{ rank: 1, emitted: 10 },
				{ rank: 2, emitted: 40 },
				{ rank: 3, emitted: 20 },
			]),
		).toBe(0);
	});

	test("handles the agent never emitted are evidence about nothing", () => {
		// The tie rule, and it matters at real scale: 18 of 49 handles in the recorded
		// run were emitted zero times. If ties counted as disagreements the score would
		// be dominated by them and would say the ranking is inverted when what actually
		// happened is that most of the table was unused. Two emitted handles in the
		// right order plus any number of zeros is still perfect agreement on the pairs
		// that carry information.
		expect(
			rankAgreement([
				{ rank: 0, emitted: 5 },
				{ rank: 1, emitted: 3 },
				{ rank: 2, emitted: 0 },
				{ rank: 3, emitted: 0 },
				{ rank: 4, emitted: 0 },
			]),
		).toBe(1);
	});

	test("a table where nothing was emitted scores 0 rather than dividing by zero", () => {
		// A NaN here would print as a result. Zero is also the honest reading: with no
		// emissions there is no evidence either way.
		expect(
			rankAgreement([
				{ rank: 0, emitted: 0 },
				{ rank: 1, emitted: 0 },
			]),
		).toBe(0);
		expect(rankAgreement([])).toBe(0);
	});
});

/** Build a small git repository and a transcript recorded in it. */
function fixture(): { repo: string; sessions: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-retype-fixture-"));
	const repo = path.join(root, "repo");
	const sessions = path.join(root, "sessions");
	fs.mkdirSync(repo);
	fs.mkdirSync(sessions);

	for (let i = 0; i < 8; i++) {
		fs.writeFileSync(
			path.join(repo, `mod${i}.ts`),
			[
				`import { helper } from "@fixture/deeply/nested/module/path";`,
				`export function run${i}(input: string): string {`,
				`\t\tconst value = helper(input);`,
				`\t\tconst other = helper(value);`,
				`\t\treturn other;`,
				`}`,
			].join("\n"),
		);
	}
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	Bun.spawnSync(["git", "add", "."], { cwd: repo });

	return { repo, sessions, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write a transcript whose session ran in `cwd` and whose assistant emitted `texts`. */
function writeTranscript(sessions: string, name: string, cwd: string, texts: string[]): void {
	const lines = [JSON.stringify({ type: "session", version: 3, cwd })];
	for (const text of texts) {
		lines.push(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { content: text } }],
				},
			}),
		);
	}
	fs.writeFileSync(path.join(sessions, name), `${lines.join("\n")}\n`);
}

describe("measuring a repository against its own transcripts", () => {
	test("counts every emission of a handle's expansion, not just the first", () => {
		// The core count. Three copies of the same structure run in one emitted string
		// is three uses, and a counter that stopped at the first would understate every
		// row by the amount that repetition is worth, which is the whole point.
		const { repo, sessions, cleanup } = fixture();
		try {
			writeTranscript(sessions, "a.jsonl", repo, ["x\n\t\ty\n\t\tz\n\t\tw"]);
			const report = measureRetype(repo, sessions);

			const indent = report.rows.find(row => row.expansion === "\n\t\t");
			expect(indent).toBeDefined();
			expect(indent?.emitted).toBe(3);
		} finally {
			cleanup();
		}
	});

	test("a session recorded in another repository is not counted", () => {
		// The attribution rule, and the reason the real run reports 100 of 307
		// transcripts. Without it the measurement would credit this repository with
		// everything the user ever typed anywhere, which is how a dictionary looks
		// useful when it is not.
		const { repo, sessions, cleanup } = fixture();
		try {
			writeTranscript(sessions, "elsewhere.jsonl", path.join(repo, "..", "other-repo"), ["x\n\t\ty\n\t\tz"]);
			const report = measureRetype(repo, sessions);

			expect(report.transcriptsForRepo).toBe(0);
			for (const row of report.rows) expect(row.emitted).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("a session in a subdirectory of the repository IS counted", () => {
		// The other half of the rule. An agent launched in `packages/x` is working in
		// the same repository, and dropping those sessions would throw away most of a
		// monorepo's evidence.
		const { repo, sessions, cleanup } = fixture();
		try {
			writeTranscript(sessions, "sub.jsonl", path.join(repo, "nested", "dir"), ["x\n\t\ty"]);
			const report = measureRetype(repo, sessions);

			expect(report.transcriptsForRepo).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("a transcript with no session event is skipped rather than attributed", () => {
		// It cannot be placed, and guessing would put another project's turns in this
		// repository's ledger. Skipping is the conservative direction: it understates
		// the saving rather than inventing one.
		const { repo, sessions, cleanup } = fixture();
		try {
			fs.writeFileSync(
				path.join(sessions, "headless.jsonl"),
				`${JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "x\n\t\ty" }] },
				})}\n`,
			);
			const report = measureRetype(repo, sessions);

			expect(report.transcriptsForRepo).toBe(0);
			expect(report.assistantMessages).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("the input the dictionary costs is counted against the output it saved", () => {
		// THE LEDGER THE GENERATOR NEVER SEES, and the finding this instrument exists
		// to produce. A dictionary is input carried on every turn; its savings are
		// output produced per emission. On the fixture, as in the real run, the carried
		// input is far larger than anything saved, and the report has to say so rather
		// than print a savings column alone.
		const { repo, sessions, cleanup } = fixture();
		try {
			writeTranscript(sessions, "a.jsonl", repo, ["x\n\t\ty"]);
			const report = measureRetype(repo, sessions);

			expect(report.dictTokens).toBeGreaterThan(0);
			expect(report.assistantMessages).toBe(1);
			expect(report.carriedInputTokens).toBe(report.dictTokens * report.assistantMessages);
			expect(report.carriedInputTokens).toBeGreaterThan(report.actualSavedTokens);
		} finally {
			cleanup();
		}
	});

	test("a handle the agent never wrote is reported as zero, not omitted", () => {
		// A row dropped for having no uses would hide exactly the budget being wasted.
		// Every generated handle appears, and `neverEmitted` counts the dead ones.
		const { repo, sessions, cleanup } = fixture();
		try {
			writeTranscript(sessions, "a.jsonl", repo, ["nothing from the dictionary here"]);
			const report = measureRetype(repo, sessions);

			expect(report.rows.length).toBe(report.handles);
			expect(report.neverEmitted).toBe(report.handles);
			expect(report.actualSavedTokens).toBe(0);
		} finally {
			cleanup();
		}
	});
});

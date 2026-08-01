import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { fuzzDir } from "./fuzz";
import {
	type Artifact,
	type Finding,
	fileIssues,
	HARNESS_SIGNATURES_PATH,
	isHarnessSignature,
	listArtifacts,
	normalizeLocation,
	parseArgs,
	parseCrashSignature,
	parseHarnessSignatures,
	parseRepoFromRemote,
	renderFileCommands,
	renderIssueBody,
	renderIssueTitle,
	renderReport,
	signatureKey,
	stripCounts,
	triage,
	UsageError,
} from "./fuzz-triage";

/**
 * Real libFuzzer output, trimmed. Using a synthetic string here would test the
 * parser against a shape libFuzzer does not actually produce, which is how a
 * signature parser passes its tests and matches nothing in the field.
 */
const PANIC_OUTPUT = [
	"INFO: Seed: 3935952248",
	"",
	"thread '<unnamed>' (2944698) panicked at fuzz_targets/keys_parse.rs:96:9:",
	'parse_key said [27, 27, 79] is "alt+alt+shift+o", but matches_key disagrees',
	"note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
	"==2944698== ERROR: libFuzzer: deadly signal",
	"    #0 0x5cc41727d531  (/mnt/target/keys_parse+0xd4531)",
	"SUMMARY: libFuzzer: deadly signal",
].join("\n");

const ASSERT_OUTPUT = [
	"thread '<unnamed>' (2944883) panicked at fuzz_targets/minimizer_lint_condense.rs:101:5:",
	'assertion `left == right` failed: "eslint" is not idempotent; a second pass changed its own output',
	'  left: ""',
	' right: "0 (×2)\\n"',
	"==2944883== ERROR: libFuzzer: deadly signal",
].join("\n");

const DEPENDENCY_PANIC_OUTPUT = [
	"thread '<unnamed>' (2944651) panicked at /home/someone/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/ast-grep-core-0.39.9/src/match_tree/mod.rs:79:7:",
	"Ellipsis should be matched in parent level",
	"==2944651== ERROR: libFuzzer: deadly signal",
].join("\n");

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		target: "keys_parse",
		signature: {
			kind: "panic",
			location: "fuzz_targets/keys_parse.rs:96:9",
			message: "parse_key disagrees",
		},
		artifacts: ["crash-aaa"],
		harness: false,
		...overrides,
	};
}

describe("parseCrashSignature", () => {
	/**
	 * The ordinary case: a panic in a target's own assertion. The message is what
	 * distinguishes two bugs in the same target, so it has to survive.
	 */
	it("reads the location and message from a panic", () => {
		expect(parseCrashSignature(PANIC_OUTPUT)).toEqual({
			kind: "panic",
			location: "fuzz_targets/keys_parse.rs:96:9",
			message: 'parse_key said [27, 27, 79] is "alt+alt+shift+o", but matches_key disagrees',
		});
	});

	/** An `assert_eq!` reads differently and is classified as such. */
	it("classifies an assertion failure", () => {
		const signature = parseCrashSignature(ASSERT_OUTPUT);

		expect(signature?.kind).toBe("assert");
		expect(signature?.location).toBe("fuzz_targets/minimizer_lint_condense.rs:101:5");
	});

	/**
	 * A panic inside a dependency reports an absolute path through the cargo
	 * registry, whose hash directory differs per machine. Two people triaging the
	 * same crash have to reach the same signature.
	 */
	it("normalizes a dependency path so the signature is machine-independent", () => {
		expect(parseCrashSignature(DEPENDENCY_PANIC_OUTPUT)?.location).toBe(
			"ast-grep-core-0.39.9/src/match_tree/mod.rs:79:7",
		);
	});

	/** libFuzzer reports OOM and timeout as findings too, and neither is a panic. */
	it("recognizes out-of-memory and timeout findings", () => {
		expect(parseCrashSignature("ERROR: libFuzzer: out-of-memory (malloc(1))")?.kind).toBe("oom");
		expect(parseCrashSignature("ERROR: libFuzzer: timeout after 25 seconds")?.kind).toBe("timeout");
	});

	/** Output with no failure in it must not produce a signature to file. */
	it("returns nothing for output that did not crash", () => {
		expect(parseCrashSignature("#100 DONE cov: 12 ft: 30 corp: 4/9b")).toBeUndefined();
	});
});

describe("normalizeLocation", () => {
	/** Repo paths keep the part a reader can open. */
	it("reduces an absolute repo path to a repo-relative one", () => {
		expect(normalizeLocation("/home/x/Santh/software/veyyon/veyyon/crates/veyyon-keys/src/lib.rs:9")).toBe(
			"crates/veyyon-keys/src/lib.rs:9",
		);
	});

	/** A location it does not recognize is passed through rather than dropped. */
	it("leaves an unrecognized location alone", () => {
		expect(normalizeLocation("somewhere/else.rs:1:2")).toBe("somewhere/else.rs:1:2");
	});
});

describe("stripCounts", () => {
	/**
	 * The message must collapse to one line. An `assert_eq!` prints the left and
	 * right values underneath, and those differ for every input that hits the same
	 * bug, so keeping them would file one issue per input.
	 */
	it("keeps only the first line", () => {
		expect(stripCounts('assertion failed: x\n  left: ""\n right: "y"')).toBe("assertion failed: x");
	});

	/** Whitespace runs are collapsed so two renderings of one message match. */
	it("collapses whitespace", () => {
		expect(stripCounts("a   b\tc")).toBe("a b c");
	});
});

describe("triage", () => {
	const artifacts: Artifact[] = [
		{ target: "keys_parse", file: "/a/crash-1", name: "crash-1" },
		{ target: "keys_parse", file: "/a/crash-2", name: "crash-2" },
		{ target: "keys_parse", file: "/a/crash-3", name: "crash-3" },
	];

	/**
	 * The reason this module exists. libFuzzer writes one artifact per crashing
	 * input and a single root cause produces many, so three artifacts with one
	 * signature are one finding.
	 */
	it("collapses artifacts that share a signature into one finding", () => {
		const result = triage(artifacts, {
			reproduce: () => ({ crashed: true, output: PANIC_OUTPUT }),
			known: [],
		});

		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.artifacts).toEqual(["crash-1", "crash-2", "crash-3"]);
	});

	/** Two different signatures stay two findings. */
	it("keeps distinct signatures apart", () => {
		const outputs = [PANIC_OUTPUT, ASSERT_OUTPUT, PANIC_OUTPUT];
		let call = 0;
		const result = triage(artifacts, {
			reproduce: () => ({ crashed: true, output: outputs[call++]! }),
			known: [],
		});

		expect(result.findings).toHaveLength(2);
		expect(result.findings.map(entry => entry.artifacts)).toEqual([["crash-1", "crash-3"], ["crash-2"]]);
	});

	/**
	 * An artifact is a record of a crash that happened once, not a claim about
	 * today. Four of the nine artifacts on disk on 2026-07-25 were from bugs
	 * already fixed, and filing those sends somebody to investigate working code.
	 */
	it("drops artifacts that no longer reproduce", () => {
		const result = triage(artifacts, {
			reproduce: () => ({ crashed: false, output: "#100 DONE" }),
			known: [],
		});

		expect(result.findings).toHaveLength(0);
		expect(result.stale.map(entry => entry.name)).toEqual(["crash-1", "crash-2", "crash-3"]);
	});

	/** `--keep-stale` is for auditing the artifact directory rather than for filing. */
	it("keeps stale artifacts when asked, and still needs a signature to report one", () => {
		const result = triage(artifacts, {
			reproduce: () => ({ crashed: false, output: "#100 DONE" }),
			known: [],
			keepStale: true,
		});

		expect(result.stale).toHaveLength(0);
		expect(result.inconclusive).toHaveLength(3);
	});

	/** A crash whose output cannot be parsed is reported, never silently dropped. */
	it("reports a crash with no readable signature rather than discarding it", () => {
		const result = triage([artifacts[0]!], {
			reproduce: () => ({ crashed: true, output: "something went wrong" }),
			known: [],
		});

		expect(result.findings).toHaveLength(0);
		expect(result.inconclusive.map(entry => entry.name)).toEqual(["crash-1"]);
	});

	/** A known harness signature is still reported, just marked so it is not filed. */
	it("marks a known harness signature instead of hiding it", () => {
		const result = triage([artifacts[0]!], {
			reproduce: () => ({ crashed: true, output: PANIC_OUTPUT }),
			known: [{ location: "fuzz_targets/keys_parse.rs", message: "" }],
		});

		expect(result.findings[0]!.harness).toBe(true);
	});
});

describe("signatureKey", () => {
	/** Same target, same place, same message is the same bug. */
	it("is equal for two crashes with the same signature", () => {
		const signature = { kind: "panic", location: "a.rs:1", message: "boom" };

		expect(signatureKey("t", signature)).toBe(signatureKey("t", { ...signature }));
	});

	/** The same assertion in two targets is two findings, since the fix differs. */
	it("distinguishes the same signature in two targets", () => {
		const signature = { kind: "panic", location: "a.rs:1", message: "boom" };

		expect(signatureKey("one", signature)).not.toBe(signatureKey("two", signature));
	});
});

describe("parseHarnessSignatures", () => {
	/** The shipped file must parse, whatever it currently contains. */
	it("parses the file that ships in the repo", () => {
		expect(fs.existsSync(HARNESS_SIGNATURES_PATH)).toBe(true);
		expect(() => parseHarnessSignatures(fs.readFileSync(HARNESS_SIGNATURES_PATH, "utf-8"))).not.toThrow();
	});

	/**
	 * The shipped file is deliberately empty, and that is worth pinning. An entry
	 * for the ast-grep ellipsis assert was written and then removed, because the
	 * identical signature is reachable both from the probe (harness) and from
	 * `collect_matches` (a real crash), so the filter would have permanently
	 * hidden a live bug. If somebody adds it back, this fails and they have to
	 * read why.
	 */
	it("ships with no suppressions", () => {
		const entries = parseHarnessSignatures(fs.readFileSync(HARNESS_SIGNATURES_PATH, "utf-8"));

		expect(entries).toEqual([]);
	});

	/** Multiple entries, since the format has to work when it is used. */
	it("reads every entry", () => {
		const contents = [
			"# comment",
			"[[signature]]",
			'location = "a.rs"',
			'message = "boom"',
			"",
			"[[signature]]",
			'location = "b.rs"',
		].join("\n");

		expect(parseHarnessSignatures(contents)).toEqual([
			{ location: "a.rs", message: "boom" },
			{ location: "b.rs", message: "" },
		]);
	});
});

describe("isHarnessSignature", () => {
	const signature = {
		kind: "panic",
		location: "ast-grep-core-0.39.9/src/match_tree/mod.rs:79:7",
		message: "Ellipsis should be matched in parent level",
	};

	/** Both halves are substrings, so a line number change does not un-suppress. */
	it("matches on location and message substrings", () => {
		expect(
			isHarnessSignature(signature, [{ location: "match_tree/mod.rs", message: "Ellipsis should be matched" }]),
		).toBe(true);
	});

	/** An empty message means any message at that location. */
	it("matches any message when the entry has none", () => {
		expect(isHarnessSignature(signature, [{ location: "match_tree/mod.rs", message: "" }])).toBe(true);
	});

	/** A location match with the wrong message is not a match. */
	it("does not match when the message differs", () => {
		expect(isHarnessSignature(signature, [{ location: "match_tree/mod.rs", message: "something else" }])).toBe(false);
	});
});

describe("renderIssueBody", () => {
	/**
	 * The constraints are the reason the body is generated rather than pasted. A
	 * crash can always be made to go away by relaxing the property that caught it,
	 * which is the single most likely thing an automated fix produces.
	 */
	it("forbids weakening the assertion and editing the fuzz suite", () => {
		const body = renderIssueBody(finding());

		expect(body).toContain("Do not weaken or delete the assertion");
		expect(body).toContain("Do not change anything under `fuzz/`");
		expect(body).toContain("fails before the fix and passes after");
	});

	/** No auto-merge, stated in the issue rather than left to convention. */
	it("says the PR is not to be merged without review", () => {
		expect(renderIssueBody(finding())).toContain("Do not merge it");
	});

	/** A finding nobody can reproduce locally is a finding nobody will fix. */
	it("carries a runnable reproduction command", () => {
		expect(renderIssueBody(finding())).toContain(
			"cargo +nightly fuzz run keys_parse fuzz/artifacts/keys_parse/crash-aaa",
		);
	});

	/** When several artifacts share the signature, all of them are listed. */
	it("lists every artifact that produces the signature", () => {
		const body = renderIssueBody(finding({ artifacts: ["crash-a", "crash-b"] }));

		expect(body).toContain("2 artifacts produce this same signature");
		expect(body).toContain("crash-a");
		expect(body).toContain("crash-b");
	});

	/** It points at the target's header comment, which states the property. */
	it("points the reader at the target that found it", () => {
		expect(renderIssueBody(finding())).toContain("fuzz/fuzz_targets/keys_parse.rs");
	});
});

describe("renderIssueTitle", () => {
	/** The title identifies the crash, since it is the dedup key a human reads. */
	it("names the target and where it crashed", () => {
		expect(renderIssueTitle(finding())).toBe("fuzz: keys_parse panic at fuzz_targets/keys_parse.rs:96:9");
	});
});

describe("parseRepoFromRemote", () => {
	/** Read from git rather than hardcoded, so a fork does not file upstream. */
	it("reads owner/name from an ssh remote", () => {
		expect(parseRepoFromRemote("git@github.com:santhreal/veyyon.git\n")).toBe("santhreal/veyyon");
	});

	it("reads owner/name from an https remote", () => {
		expect(parseRepoFromRemote("https://github.com/santhreal/veyyon\n")).toBe("santhreal/veyyon");
	});

	/** A non-GitHub remote yields nothing rather than a wrong guess. */
	it("returns nothing for a remote it does not understand", () => {
		expect(parseRepoFromRemote("/srv/git/veyyon.git")).toBeUndefined();
	});
});

describe("renderFileCommands", () => {
	/** Filing creates the issue and nothing else. */
	it("creates the issue", () => {
		const commands = renderFileCommands(finding(), "santhreal/veyyon");

		expect(commands).toHaveLength(1);
		expect(commands[0]!.argv.slice(0, 4)).toEqual(["issue", "create", "--repo", "santhreal/veyyon"]);
	});
});

/**
 * `fileIssues` writes through the sink it was given.
 *
 * WHY THE SINK IS ASSERTED AND NOT JUST ACCEPTED. These cases drive the real
 * `fileIssues`, which prints the whole rendered issue body before asking. With
 * the writes going to `console` that put about 150 lines of issue text into the
 * scripts bucket's log on every CI run, including the words `gh issue create
 * failed` from the case that injects a failing `gh`, which is precisely what a
 * reader scanning a bucket for a real failure stops on. So the output is now
 * injected like `gh` and `confirm` are, and it is ASSERTED rather than merely
 * swallowed: the prompt text, the `Would run against` line and the two failure
 * messages are what a person filing a triage batch reads, and none of them had
 * any coverage while all of them were being printed.
 */
describe("fileIssues", () => {
	/** A sink that keeps every line, standing in for the terminal. */
	function sink() {
		const said: string[] = [];
		const warned: string[] = [];
		return { said, warned, say: (line: string) => said.push(line), warn: (line: string) => warned.push(line) };
	}

	const ORIGIN = "git@github.com:santhreal/veyyon.git";

	/**
	 * The whole safety property: declining leaves the repository untouched. There
	 * is no flag that skips this prompt, because an unattended path to `gh issue
	 * create` is how one bad triage run becomes twenty issues.
	 */
	it("runs nothing when the answer is no", () => {
		const calls: string[][] = [];
		const out = sink();
		const questions: string[] = [];
		const status = fileIssues(
			[finding()],
			{},
			{
				confirm: question => {
					questions.push(question);
					return false;
				},
				gh: argv => {
					calls.push(argv);
					return { status: 0, output: "" };
				},
				originRemote: () => ORIGIN,
				...out,
			},
		);

		expect(status).toBe(0);
		expect(calls).toEqual([]);
		// The prompt has to read as a question with a default of no, since a reader
		// hitting Enter on a batch of twenty must file nothing.
		expect(questions).toEqual(["File this one? [y/N] "]);
		expect(out.said.at(-1)).toBe("Skipped.");
	});

	/** On yes, exactly one issue is created and nothing else. */
	it("creates one issue per finding when confirmed", () => {
		const calls: string[][] = [];
		const out = sink();
		fileIssues(
			[finding(), finding({ artifacts: ["crash-b"] })],
			{},
			{
				confirm: () => true,
				gh: argv => {
					calls.push(argv);
					return { status: 0, output: "https://github.com/santhreal/veyyon/issues/1\n" };
				},
				originRemote: () => ORIGIN,
				...out,
			},
		);

		expect(calls).toHaveLength(2);
		expect(calls.every(argv => argv[1] === "create")).toBe(true);
		// The created URL is echoed once per finding, which is the only record the
		// person filing keeps of what was made.
		expect(out.said.filter(line => line === "https://github.com/santhreal/veyyon/issues/1")).toHaveLength(2);
		expect(out.warned).toEqual([]);
	});

	/**
	 * The preview names the repository and every command, before the prompt.
	 *
	 * This line is the last thing a reader sees before answering, so it decides
	 * whether they can tell `santhreal/veyyon` from a fork. It was printed and
	 * unasserted.
	 */
	it("previews the repository and the commands before asking", () => {
		const out = sink();
		fileIssues(
			[finding()],
			{},
			{
				confirm: () => false,
				gh: () => ({ status: 0, output: "" }),
				originRemote: () => ORIGIN,
				...out,
			},
		);

		expect(out.said).toContain("\nWould run against santhreal/veyyon: create the issue");
		expect(out.said.some(line => line.includes("fuzz_targets/keys_parse.rs:96:9"))).toBe(true);
		expect(out.said.at(0)).toBe(`\n${renderIssueTitle(finding())}`);
	});

	/** A failed create stops the run and says why. */
	it("stops when the issue could not be created", () => {
		const calls: string[][] = [];
		const out = sink();
		const status = fileIssues(
			[finding()],
			{},
			{
				confirm: () => true,
				gh: argv => {
					calls.push(argv);
					return { status: 1, output: "gh: not authenticated" };
				},
				originRemote: () => ORIGIN,
				...out,
			},
		);

		expect(status).toBe(1);
		expect(calls).toHaveLength(1);
		// The failure carries `gh`'s own words, because "it failed" without them
		// sends the reader to re-run the command by hand to find out why.
		expect(out.warned).toEqual(["gh issue create failed:\ngh: not authenticated"]);
	});

	/** Without a determinable repository it refuses rather than guessing one. */
	it("refuses when the repository cannot be determined", () => {
		const out = sink();
		const status = fileIssues(
			[finding()],
			{},
			{
				confirm: () => true,
				gh: () => ({ status: 0, output: "" }),
				originRemote: () => "/srv/git/veyyon.git",
				...out,
			},
		);

		expect(status).toBe(2);
		// And it says which flag fixes it, since the remote it could not parse is
		// often a local path in a worktree.
		expect(out.warned).toEqual(["Could not determine the repository. Pass --repo=owner/name."]);
		expect(out.said).toEqual([]);
	});

	/**
	 * Nothing to file is a clean zero, not a refusal.
	 *
	 * The ordinary outcome of a triage run where every artifact was a harness bug,
	 * and it must not look like the repository lookup failed.
	 */
	it("says there is nothing to file when every finding was filtered out", () => {
		const out = sink();
		const calls: string[][] = [];
		const status = fileIssues(
			[],
			{},
			{
				confirm: () => true,
				gh: argv => {
					calls.push(argv);
					return { status: 0, output: "" };
				},
				originRemote: () => ORIGIN,
				...out,
			},
		);

		expect(status).toBe(0);
		expect(calls).toEqual([]);
		expect(out.said).toEqual(["Nothing to file."]);
		expect(out.warned).toEqual([]);
	});
});

describe("parseArgs", () => {
	/** The three commands, and nothing else. */
	it("accepts the commands it documents", () => {
		expect(parseArgs(["report"]).command).toBe("report");
		expect(parseArgs(["issues"]).command).toBe("issues");
		expect(parseArgs(["file"]).command).toBe("file");
	});

	it("rejects an unknown command", () => {
		expect(() => parseArgs(["publish"])).toThrow(UsageError);
	});

	it("rejects an unknown option rather than ignoring it", () => {
		expect(() => parseArgs(["report", "--yes"])).toThrow(UsageError);
	});

	it("collects repeated --target flags", () => {
		expect(parseArgs(["report", "--target=a", "--target=b"]).targets).toEqual(["a", "b"]);
	});
});

describe("listArtifacts", () => {
	/** Reads the real directory layout the runner writes. */
	it("finds crash artifacts under the fuzz artifacts directory", () => {
		const artifacts = listArtifacts(fuzzDir, ["keys_parse"]);

		for (const artifact of artifacts) {
			expect(artifact.name.startsWith("crash-")).toBe(true);
			expect(fs.existsSync(artifact.file)).toBe(true);
			expect(artifact.file).toContain(path.join("artifacts", "keys_parse"));
		}
	});

	/** A target with no artifacts is not an error. */
	it("returns nothing for a target that never crashed", () => {
		expect(listArtifacts(fuzzDir, ["a_target_that_does_not_exist"])).toEqual([]);
	});
});

describe("renderReport", () => {
	/** The count a reader acts on excludes the harness artefacts. */
	it("counts only the findings worth acting on", () => {
		const report = renderReport({
			findings: [finding(), finding({ harness: true })],
			stale: [],
			inconclusive: [],
		});

		expect(report).toContain("1 distinct crash(es) to act on.");
		expect(report).toContain("1 known harness artefact(s), not filed");
	});

	/** Stale artifacts are stated rather than silently dropped. */
	it("says how many artifacts no longer reproduce", () => {
		const report = renderReport({
			findings: [],
			stale: [{ target: "keys_parse", file: "/a/crash-1", name: "crash-1" }],
			inconclusive: [],
		});

		expect(report).toContain("1 artifact(s) no longer reproduce");
		expect(report).toContain("keys_parse/crash-1");
	});
});

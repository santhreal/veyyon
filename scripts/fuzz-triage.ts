#!/usr/bin/env bun

/**
 * Triage for the crash artifacts the fuzzing suite leaves in `fuzz/artifacts/`.
 *
 * A fuzz run that ends with "3 targets reported findings" is not yet a finding
 * anybody can act on. The artifacts pile up, several of them are the same bug,
 * some no longer reproduce because the bug was fixed, and at least one class is
 * not a bug at all. This turns that pile into a deduplicated list of distinct,
 * still-reproducing crashes, each with the signature that identifies it.
 *
 * THE THREE THINGS IT DOES, AND WHY EACH ONE IS LOAD-BEARING.
 *
 * 1. REPRODUCE AGAINST THE CURRENT TREE. An artifact is a historical record of
 *    a crash, not a claim about today. On 2026-07-25 four of the nine artifacts
 *    on disk were from bugs already fixed. Filing those would send somebody to
 *    investigate working code.
 *
 * 2. DEDUPLICATE BY SIGNATURE, NOT BY INPUT. libFuzzer writes one artifact per
 *    crashing input, and a single root cause produces many inputs: the `$$$`
 *    ellipsis bug alone accounts for four. The signature is where it crashed and
 *    what it said, normalized, so those four collapse to one.
 *
 * 3. SEPARATE HARNESS ARTEFACTS FROM CODE BUGS. libfuzzer-sys installs a panic
 *    hook that aborts before unwinding, so any code whose contract is "convert a
 *    panic into an error" crashes the fuzzer while behaving correctly. That is a
 *    property of the harness. Signatures known to be that are listed in
 *    `fuzz/known-harness-signatures.toml` and reported separately rather than
 *    filed, because an issue for one asks somebody to break working code to
 *    silence a false alarm.
 *
 * NOTHING HERE TOUCHES GITHUB ON ITS OWN. `report` and `issues` are read-only.
 * `file` is the only command that reaches the network, it is never invoked by a
 * campaign or a hook, and it asks before each issue. That is deliberate: the
 * triage above is good enough to stop the obvious false positives and not good
 * enough to be trusted unattended. See `docs/internal/fuzzing.md`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_TARGET_DIR, fuzzDir, readTargetNames, repoRoot } from "./fuzz";

/** Seconds a single reproduction attempt may take before it is inconclusive. */
export const REPRODUCE_TIMEOUT_SECONDS = 120;

/** Where the known-harness signature list lives. Tier B data, not a hardcoded list. */
export const HARNESS_SIGNATURES_PATH = path.join(fuzzDir, "known-harness-signatures.toml");

export class UsageError extends Error {}

export const COMMANDS = ["report", "issues", "file"] as const;
export type Command = (typeof COMMANDS)[number];

export const USAGE = `Usage: bun scripts/fuzz-triage.ts <command> [options]

Commands:
  report                Reproduce, deduplicate, and print the distinct crashes.
  issues                Print the issue body for each distinct crash, to stdout.
  file                  Create a GitHub issue per distinct crash. Asks first, one at a time.

Options:
  --target=<name>       Only triage this target. Repeatable.
  --keep-stale          Report artifacts that no longer reproduce instead of skipping them.
  --repo=<owner/name>   With 'file': the repository. Defaults to the checkout's origin.
`;

/** One crash artifact on disk. */
export type Artifact = {
	target: string;
	/** Absolute path to the artifact file. */
	file: string;
	/** The `crash-<hash>` basename, which is how libFuzzer names it. */
	name: string;
};

/** What a target printed when it crashed, reduced to the part that identifies the bug. */
export type CrashSignature = {
	/** `panic`, `assert`, `oom`, `timeout`, or `unknown`. */
	kind: string;
	/** Source location the crash was reported at, normalized to a repo-relative path. */
	location: string;
	/** First line of the crash message, with addresses and numbers left intact. */
	message: string;
};

/** A distinct crash: one signature, and every artifact that produces it. */
export type Finding = {
	target: string;
	signature: CrashSignature;
	/** Artifact basenames, sorted, so the same crash renders identically every run. */
	artifacts: string[];
	/** True when the signature is listed as a known harness artefact. */
	harness: boolean;
};

/**
 * Collect the artifacts libFuzzer has written.
 *
 * Sorted by target and then by name so a report is stable across runs; an
 * unstable report cannot be diffed against the previous one.
 */
export function listArtifacts(root: string, targets: readonly string[]): Artifact[] {
	const found: Artifact[] = [];
	for (const target of [...targets].sort()) {
		const dir = path.join(root, "artifacts", target);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir).sort()) {
			if (!name.startsWith("crash-") && !name.startsWith("oom-") && !name.startsWith("timeout-")) {
				continue;
			}
			found.push({ target, file: path.join(dir, name), name });
		}
	}
	return found;
}

/**
 * Reduce crash output to the signature that identifies the bug.
 *
 * Reads the panic line and the message under it. Everything else in libFuzzer's
 * output (the stack addresses, the corpus counts, the seed) differs between two
 * runs of the SAME bug, so including any of it would defeat the deduplication
 * this exists for.
 */
export function parseCrashSignature(output: string): CrashSignature | undefined {
	const lines = output.split("\n");

	const panicIndex = lines.findIndex(line => line.includes("panicked at "));
	if (panicIndex >= 0) {
		const location = normalizeLocation(lines[panicIndex]!.split("panicked at ")[1]?.trim() ?? "");
		const message = (lines[panicIndex + 1] ?? "").trim();
		const kind = message.startsWith("assertion") ? "assert" : "panic";
		return { kind, location, message: stripCounts(message) };
	}

	if (output.includes("ERROR: libFuzzer: out-of-memory")) {
		return { kind: "oom", location: "", message: "libFuzzer: out-of-memory" };
	}
	if (output.includes("ERROR: libFuzzer: timeout")) {
		return { kind: "timeout", location: "", message: "libFuzzer: timeout" };
	}
	if (output.includes("ERROR: AddressSanitizer")) {
		const line = lines.find(entry => entry.includes("ERROR: AddressSanitizer")) ?? "";
		return { kind: "asan", location: "", message: stripCounts(line.trim()) };
	}
	return undefined;
}

/**
 * Make a crash location comparable between machines.
 *
 * A panic inside a dependency reports an absolute path through the cargo
 * registry, which contains a per-machine hash directory. Two people triaging the
 * same crash have to arrive at the same signature or the deduplication is
 * per-machine.
 */
export function normalizeLocation(rawLocation: string): string {
	// libFuzzer writes `panicked at <location>:` and the trailing colon is the log
	// line's punctuation, not part of the location. It would otherwise end up in
	// the issue title.
	const location = rawLocation.trim().replace(/:$/, "");
	const registry = location.match(/index\.crates\.io-[^/]+\/(.+)$/);
	if (registry) return registry[1]!;
	const local = location.match(/veyyon\/(crates\/.+|fuzz\/.+)$/);
	if (local) return local[1]!;
	return location;
}

/**
 * Drop the parts of an assertion message that vary per input.
 *
 * `assertion left == right failed` messages carry the actual values, which
 * differ for every input that hits the same bug. Keeping them would file one
 * issue per input, which is the thing this module exists to prevent.
 */
export function stripCounts(message: string): string {
	return message.split("\n")[0]!.replace(/\s+/g, " ").trim();
}

/** The stable identity of a crash: target plus where it happened plus what it said. */
export function signatureKey(target: string, signature: CrashSignature): string {
	return [target, signature.kind, signature.location, signature.message].join(" | ");
}

/**
 * Read the signatures that are harness artefacts rather than code bugs.
 *
 * A minimal parser rather than a TOML dependency: the file is a list of
 * `location = "..."` / `message = "..."` pairs under `[[signature]]` headers,
 * and the runner already parses `fuzz/Cargo.toml` the same way. Returns the
 * substrings to match, since a message may carry a value that varies.
 */
export function parseHarnessSignatures(contents: string): { location: string; message: string }[] {
	const entries: { location: string; message: string }[] = [];
	let current: { location?: string; message?: string } | undefined;

	for (const raw of contents.split("\n")) {
		const line = raw.trim();
		if (line === "[[signature]]") {
			if (current?.location !== undefined) {
				entries.push({ location: current.location, message: current.message ?? "" });
			}
			current = {};
			continue;
		}
		if (!current) continue;
		const match = line.match(/^(location|message)\s*=\s*"(.*)"$/);
		if (!match) continue;
		if (match[1] === "location") current.location = match[2]!;
		else current.message = match[2]!;
	}
	if (current?.location !== undefined) {
		entries.push({ location: current.location, message: current.message ?? "" });
	}
	return entries;
}

/** True when this signature is a known harness artefact rather than a code bug. */
export function isHarnessSignature(
	signature: CrashSignature,
	known: readonly { location: string; message: string }[],
): boolean {
	return known.some(
		entry =>
			signature.location.includes(entry.location) &&
			(entry.message === "" || signature.message.includes(entry.message)),
	);
}

/** Load the harness signature list, or an empty list when the file is absent. */
export function readHarnessSignatures(file = HARNESS_SIGNATURES_PATH): {
	location: string;
	message: string;
}[] {
	if (!fs.existsSync(file)) return [];
	return parseHarnessSignatures(fs.readFileSync(file, "utf-8"));
}

/**
 * Run one artifact back through its target.
 *
 * Returns the output and whether the target crashed. `cargo fuzz run <target>
 * <artifact>` runs that single input and exits, so this is bounded work rather
 * than a campaign.
 */
export function reproduce(target: string, artifact: string, run = runCargoFuzz): { crashed: boolean; output: string } {
	const result = run(["run", target, artifact, "--", `-timeout=${REPRODUCE_TIMEOUT_SECONDS}`]);
	return { crashed: result.status !== 0, output: result.output };
}

/** Invoke `cargo +nightly fuzz`, capturing both streams. */
export function runCargoFuzz(args: string[]): { status: number; output: string } {
	const result = spawnSync("cargo", ["+nightly", "fuzz", ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
		timeout: (REPRODUCE_TIMEOUT_SECONDS + 60) * 1000,
		env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? DEFAULT_TARGET_DIR },
	});
	return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Group artifacts into distinct findings.
 *
 * Artifacts that no longer crash are dropped unless `keepStale` is set: the bug
 * they recorded is fixed, and reporting it again is how a triage list teaches
 * people to ignore it.
 */
export function triage(
	artifacts: readonly Artifact[],
	options: {
		reproduce: (target: string, file: string) => { crashed: boolean; output: string };
		known: readonly { location: string; message: string }[];
		keepStale?: boolean;
	},
): { findings: Finding[]; stale: Artifact[]; inconclusive: Artifact[] } {
	const byKey = new Map<string, Finding>();
	const stale: Artifact[] = [];
	const inconclusive: Artifact[] = [];

	for (const artifact of artifacts) {
		const { crashed, output } = options.reproduce(artifact.target, artifact.file);
		if (!crashed && !options.keepStale) {
			stale.push(artifact);
			continue;
		}
		const signature = parseCrashSignature(output);
		if (!signature) {
			inconclusive.push(artifact);
			continue;
		}
		const key = signatureKey(artifact.target, signature);
		const existing = byKey.get(key);
		if (existing) {
			existing.artifacts.push(artifact.name);
			existing.artifacts.sort();
			continue;
		}
		byKey.set(key, {
			target: artifact.target,
			signature,
			artifacts: [artifact.name],
			harness: isHarnessSignature(signature, options.known),
		});
	}

	return { findings: [...byKey.values()], stale, inconclusive };
}

/**
 * Render the issue body for one finding.
 *
 * THE RULES IN THE BODY ARE THE POINT. A crash can always be made to go away by
 * relaxing the property that caught it, and that is the single most likely thing
 * an automated fix produces: the fuzz target stops asserting, the crash stops
 * happening, and the bug ships. So the body states what may not be touched and
 * what the fix has to come with. It also carries the reproduction command, since
 * a finding nobody can reproduce locally is a finding nobody will fix.
 */
export function renderIssueBody(finding: Finding): string {
	const artifacts = finding.artifacts.map(name => `fuzz/artifacts/${finding.target}/${name}`);
	return [
		`\`${finding.target}\` crashes with:`,
		"",
		"```",
		`${finding.signature.kind} at ${finding.signature.location}`,
		finding.signature.message,
		"```",
		"",
		`Reproduce: \`cargo +nightly fuzz run ${finding.target} ${artifacts[0]}\``,
		"",
		artifacts.length > 1
			? `${artifacts.length} artifacts produce this same signature:\n${artifacts.map(entry => `- \`${entry}\``).join("\n")}`
			: `Artifact: \`${artifacts[0]}\``,
		"",
		"The fuzz target's header comment says what property it is asserting and why. Read it first:",
		`\`fuzz/fuzz_targets/${finding.target}.rs\`.`,
		"",
		"Constraints on the fix:",
		"",
		"- Do not weaken or delete the assertion that caught this. If the property is genuinely wrong, say so in the PR and make it MORE precise, never looser.",
		"- Do not change anything under `fuzz/` except to add a target or a generator. The crash has to stop because the code is correct, not because nothing is checking.",
		"- Land a regression test in the crate's own `tests/` directory that fails before the fix and passes after, asserting real values rather than that a call returned.",
		"- Update the docs that describe the changed behaviour in the same change.",
		"",
		"Open a PR. Do not merge it: every fix for a fuzz finding gets read by a person first, because the",
		"cheapest way to make a crash stop is to stop checking for it and that is not always obvious in a diff.",
	].join("\n");
}

/**
 * Parse `owner/name` out of the checkout's origin remote.
 *
 * Read from git rather than hardcoded, so a fork or a rename does not silently
 * file issues against the wrong repository.
 */
export function parseRepoFromRemote(remote: string): string | undefined {
	const match = remote.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
	return match?.[1];
}

/** The commands `file` would run for one finding, in order. Rendered rather than run, so they can be shown before anything happens. */
export function renderFileCommands(finding: Finding, repo: string): { label: string; argv: string[] }[] {
	return [
		{
			label: "create the issue",
			argv: [
				"issue",
				"create",
				"--repo",
				repo,
				"--title",
				renderIssueTitle(finding),
				"--body",
				renderIssueBody(finding),
			],
		},
	];
}

/** Render the issue title. Kept short and identifying, since it is the dedup key humans read. */
export function renderIssueTitle(finding: Finding): string {
	const where = finding.signature.location || finding.signature.kind;
	return `fuzz: ${finding.target} ${finding.signature.kind} at ${where}`;
}

/** Parse `--flag=value` options into a map. Bare words are the command and targets. */
export function parseArgs(argv: readonly string[]): {
	command: Command;
	targets: string[];
	keepStale: boolean;
	repo?: string;
} {
	const [command, ...rest] = argv;
	if (!command || !(COMMANDS as readonly string[]).includes(command)) {
		throw new UsageError(`Unknown command: ${command ?? "(none)"}`);
	}
	const targets: string[] = [];
	let keepStale = false;
	let repo: string | undefined;
	for (const arg of rest) {
		if (arg === "--keep-stale") {
			keepStale = true;
			continue;
		}
		const repoFlag = arg.match(/^--repo=(.+)$/);
		if (repoFlag) {
			repo = repoFlag[1]!;
			continue;
		}
		const match = arg.match(/^--target=(.+)$/);
		if (!match) throw new UsageError(`Unknown option: ${arg}`);
		targets.push(match[1]!);
	}
	return { command: command as Command, targets, keepStale, repo };
}

/** Format the human-readable report. */
export function renderReport(result: {
	findings: readonly Finding[];
	stale: readonly Artifact[];
	inconclusive: readonly Artifact[];
}): string {
	const lines: string[] = [];
	const code = result.findings.filter(finding => !finding.harness);
	const harness = result.findings.filter(finding => finding.harness);

	lines.push(`${code.length} distinct crash(es) to act on.`);
	for (const finding of code) {
		lines.push(`  ${finding.target}: ${finding.signature.kind} at ${finding.signature.location || "unknown"}`);
		lines.push(`    ${finding.signature.message}`);
		lines.push(`    ${finding.artifacts.length} artifact(s): ${finding.artifacts.join(", ")}`);
	}
	if (harness.length > 0) {
		lines.push("");
		lines.push(`${harness.length} known harness artefact(s), not filed:`);
		for (const finding of harness) {
			lines.push(`  ${finding.target}: ${finding.signature.message}`);
		}
	}
	if (result.stale.length > 0) {
		lines.push("");
		lines.push(`${result.stale.length} artifact(s) no longer reproduce:`);
		for (const artifact of result.stale) {
			lines.push(`  ${artifact.target}/${artifact.name}`);
		}
	}
	if (result.inconclusive.length > 0) {
		lines.push("");
		lines.push(`${result.inconclusive.length} artifact(s) crashed without a readable signature:`);
		for (const artifact of result.inconclusive) {
			lines.push(`  ${artifact.target}/${artifact.name}`);
		}
	}
	return lines.join("\n");
}

export function main(argv: readonly string[]): number {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(`${error.message}\n\n${USAGE}`);
		return 2;
	}

	const targets = parsed.targets.length > 0 ? parsed.targets : readTargetNames();
	const artifacts = listArtifacts(fuzzDir, targets);
	if (artifacts.length === 0) {
		console.log("No crash artifacts.");
		return 0;
	}

	console.error(`Reproducing ${artifacts.length} artifact(s) against the current tree...`);
	const result = triage(artifacts, {
		reproduce: (target, file) => reproduce(target, file),
		known: readHarnessSignatures(),
		keepStale: parsed.keepStale,
	});

	if (parsed.command === "report") {
		console.log(renderReport(result));
		return 0;
	}

	const actionable = result.findings.filter(entry => !entry.harness);

	if (parsed.command === "issues") {
		for (const finding of actionable) {
			console.log(`### ${renderIssueTitle(finding)}\n`);
			console.log(renderIssueBody(finding));
			console.log("\n---\n");
		}
		return 0;
	}

	return fileIssues(actionable, { repo: parsed.repo });
}

/**
 * Create one issue per finding, asking before each.
 *
 * Prints the exact `gh` invocation and waits for a `y`. There is no flag to skip
 * the prompt: an unattended path to `gh issue create` is how a bad triage run
 * becomes twenty issues on a repository other people read.
 *
 * Every write goes through `deps.say` and `deps.warn` rather than `console`, for
 * the same reason `gh` is injected: a caller that is not a terminal has to be
 * able to take the output. The tests are that caller, and before this they wrote
 * five rendered issue bodies (about 150 lines, one of them the words `gh issue
 * create failed`) straight into the CI runner's log, which is exactly the shape a
 * reader scanning a bucket for a real failure stops on.
 */
export function fileIssues(
	findings: readonly Finding[],
	options: { repo?: string },
	deps: {
		confirm?: (question: string) => boolean;
		gh?: (argv: string[]) => { status: number; output: string };
		originRemote?: () => string;
		say?: (line: string) => void;
		warn?: (line: string) => void;
	} = {},
): number {
	const confirm = deps.confirm ?? promptYes;
	const gh = deps.gh ?? runGh;
	const originRemote = deps.originRemote ?? readOriginRemote;
	const say = deps.say ?? ((line: string) => console.log(line));
	const warn = deps.warn ?? ((line: string) => console.error(line));

	const repo = options.repo ?? parseRepoFromRemote(originRemote());
	if (!repo) {
		warn("Could not determine the repository. Pass --repo=owner/name.");
		return 2;
	}
	if (findings.length === 0) {
		say("Nothing to file.");
		return 0;
	}

	for (const finding of findings) {
		const commands = renderFileCommands(finding, repo);
		say(`\n${renderIssueTitle(finding)}`);
		say(renderIssueBody(finding));
		say(`\nWould run against ${repo}: ${commands.map(entry => entry.label).join(", ")}`);
		if (!confirm("File this one? [y/N] ")) {
			say("Skipped.");
			continue;
		}

		const created = gh(commands[0]!.argv);
		if (created.status !== 0) {
			warn(`gh issue create failed:\n${created.output}`);
			return 1;
		}
		const url = created.output.trim().split("\n").pop() ?? "";
		say(url);
	}
	return 0;
}

/** Ask on the terminal. Anything other than `y` is no. */
function promptYes(question: string): boolean {
	process.stdout.write(question);
	const buffer = Buffer.alloc(8);
	let read = 0;
	try {
		read = fs.readSync(0, buffer, 0, buffer.length, null);
	} catch {
		return false;
	}
	return buffer.toString("utf-8", 0, read).trim().toLowerCase() === "y";
}

/** Run `gh`, capturing both streams. */
function runGh(argv: string[]): { status: number; output: string } {
	const result = spawnSync("gh", argv, { cwd: repoRoot, encoding: "utf-8" });
	return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Read the `origin` remote URL from the checkout. */
function readOriginRemote(): string {
	const result = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd: repoRoot,
		encoding: "utf-8",
	});
	return result.stdout ?? "";
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}

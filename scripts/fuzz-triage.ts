import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_TARGET_DIR, fuzzDir, readTargetNames, repoRoot } from "./fuzz";
import { rustMembers } from "./workspace-layout";

export const REPRODUCE_TIMEOUT_SECONDS = 120;
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

export type Artifact = { target: string; file: string; name: string };
export type CrashSignature = { kind: string; location: string; message: string };
export type Finding = { target: string; signature: CrashSignature; artifacts: string[]; harness: boolean };

export function listArtifacts(root: string, targets: readonly string[]): Artifact[] {
	const found: Artifact[] = [];
	for (const target of [...targets].sort()) {
		const dir = path.join(root, "artifacts", target);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir).sort()) {
			if (name.startsWith("crash-") || name.startsWith("oom-") || name.startsWith("timeout-")) {
				found.push({ target, file: path.join(dir, name), name });
			}
		}
	}
	return found;
}

export function parseCrashSignature(output: string): CrashSignature | undefined {
	const lines = output.split("\n");
	const panicIndex = lines.findIndex(line => line.includes("panicked at "));
	if (panicIndex >= 0) {
		const location = normalizeLocation(lines[panicIndex]!.split("panicked at ")[1]?.trim() ?? "");
		const message = (lines[panicIndex + 1] ?? "").trim();
		return { kind: message.startsWith("assertion") ? "assert" : "panic", location, message: stripCounts(message) };
	}
	if (output.includes("ERROR: libFuzzer: out-of-memory"))
		return { kind: "oom", location: "", message: "libFuzzer: out-of-memory" };
	if (output.includes("ERROR: libFuzzer: timeout"))
		return { kind: "timeout", location: "", message: "libFuzzer: timeout" };
	if (output.includes("ERROR: AddressSanitizer")) {
		const line = lines.find(entry => entry.includes("ERROR: AddressSanitizer")) ?? "";
		return { kind: "asan", location: "", message: stripCounts(line.trim()) };
	}
	return undefined;
}

function firstPartyTrees(): string[] {
	return [...new Set(rustMembers().map(m => m.split("/")[0]!)), "tests/fuzz"].sort();
}

export function normalizeLocation(rawLocation: string): string {
	const location = rawLocation.trim().replace(/:$/, "");
	const registry = location.match(/index\.crates\.io-[^/]+\/(.+)$/);
	if (registry) return registry[1]!;
	const local = location.match(new RegExp(`veyyon/((?:${firstPartyTrees().join("|")})/.+)$`));
	if (local) return local[1]!;
	return location;
}

export function stripCounts(message: string): string {
	return message.split("\n")[0]!.replace(/\s+/g, " ").trim();
}

export function signatureKey(target: string, signature: CrashSignature): string {
	return `${target} | ${signature.kind} | ${signature.location} | ${signature.message}`;
}

export function parseHarnessSignatures(contents: string): { location: string; message: string }[] {
	const entries: { location: string; message: string }[] = [];
	let current: { location?: string; message?: string } | undefined;
	for (const raw of contents.split("\n")) {
		const line = raw.trim();
		if (line === "[[signature]]") {
			if (current?.location !== undefined)
				entries.push({ location: current.location, message: current.message ?? "" });
			current = {};
			continue;
		}
		if (!current) continue;
		const match = line.match(/^(location|message)\s*=\s*"(.*)"$/);
		if (match) {
			if (match[1] === "location") current.location = match[2]!;
			else current.message = match[2]!;
		}
	}
	if (current?.location !== undefined) entries.push({ location: current.location, message: current.message ?? "" });
	return entries;
}

export function isHarnessSignature(
	signature: CrashSignature,
	known: readonly { location: string; message: string }[],
): boolean {
	return known.some(
		k => signature.location.includes(k.location) && (k.message === "" || signature.message.includes(k.message)),
	);
}

export function readHarnessSignatures(file = HARNESS_SIGNATURES_PATH): { location: string; message: string }[] {
	return fs.existsSync(file) ? parseHarnessSignatures(fs.readFileSync(file, "utf-8")) : [];
}

export function reproduce(target: string, artifact: string, run = runCargoFuzz): { crashed: boolean; output: string } {
	const result = run(["run", target, artifact, "--", `-timeout=${REPRODUCE_TIMEOUT_SECONDS}`]);
	return { crashed: result.status !== 0, output: result.output };
}

export function runCargoFuzz(args: string[]): { status: number; output: string } {
	const result = spawnSync("cargo", ["+nightly", "fuzz", ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
		timeout: (REPRODUCE_TIMEOUT_SECONDS + 60) * 1000,
		env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? DEFAULT_TARGET_DIR },
	});
	return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

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

export function renderIssueBody(finding: Finding): string {
	const artifacts = finding.artifacts.map(name => `tests/fuzz/artifacts/${finding.target}/${name}`);
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
		`\`tests/fuzz/fuzz_targets/${finding.target}.rs\`.`,
		"",
		"Constraints on the fix:",
		"",
		"- Do not weaken or delete the assertion that caught this. If the property is genuinely wrong, say so in the PR and make it MORE precise, never looser.",
		"- Do not change anything under `tests/fuzz/` except to add a target or a generator. The crash has to stop because the code is correct, not because nothing is checking.",
		"- Land a regression test in the crate's own `tests/` directory that fails before the fix and passes after, asserting real values rather than that a call returned.",
		"- Update the docs that describe the changed behaviour in the same change.",
		"",
		"Open a PR. Do not merge it: every fix for a fuzz finding gets read by a person first, because the",
		"cheapest way to make a crash stop is to stop checking for it and that is not always obvious in a diff.",
	].join("\n");
}

export function parseRepoFromRemote(remote: string): string | undefined {
	return remote.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
}

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

export function renderIssueTitle(finding: Finding): string {
	return `fuzz: ${finding.target} ${finding.signature.kind} at ${finding.signature.location || finding.signature.kind}`;
}

export interface FuzzTriageArgs {
	command: Command;
	targets: string[];
	keepStale: boolean;
	repo?: string;
}

export function parseArgs(argv: readonly string[]): FuzzTriageArgs {
	const [command, ...rest] = argv;
	if (!command || !(COMMANDS as readonly string[]).includes(command)) {
		throw new UsageError(`Unknown command: ${command ?? "(none)"}`);
	}
	const targets: string[] = [];
	let keepStale = false;
	let repo: string | undefined;
	for (const arg of rest) {
		if (arg === "--keep-stale") keepStale = true;
		else if (arg.startsWith("--repo=")) repo = arg.slice(7);
		else if (arg.startsWith("--target=")) targets.push(arg.slice(9));
		else throw new UsageError(`Unknown option: ${arg}`);
	}
	return { command: command as Command, targets, keepStale, repo };
}

export function renderReport(result: {
	findings: readonly Finding[];
	stale: readonly Artifact[];
	inconclusive: readonly Artifact[];
}): string {
	const lines: string[] = [];
	const code = result.findings.filter(f => !f.harness);
	const harness = result.findings.filter(f => f.harness);

	lines.push(`${code.length} distinct crash(es) to act on.`);
	for (const f of code) {
		lines.push(`  ${f.target}: ${f.signature.kind} at ${f.signature.location || "unknown"}`);
		lines.push(`    ${f.signature.message}`);
		lines.push(`    ${f.artifacts.length} artifact(s): ${f.artifacts.join(", ")}`);
	}
	if (harness.length > 0) {
		lines.push("", `${harness.length} known harness artefact(s), not filed:`);
		for (const f of harness) lines.push(`  ${f.target}: ${f.signature.message}`);
	}
	if (result.stale.length > 0) {
		lines.push("", `${result.stale.length} artifact(s) no longer reproduce:`);
		for (const a of result.stale) lines.push(`  ${a.target}/${a.name}`);
	}
	if (result.inconclusive.length > 0) {
		lines.push("", `${result.inconclusive.length} artifact(s) crashed without a readable signature:`);
		for (const a of result.inconclusive) lines.push(`  ${a.target}/${a.name}`);
	}
	return lines.join("\n");
}

export function main(argv: readonly string[]): number {
	let parsed: FuzzTriageArgs;
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

	const actionable = result.findings.filter(f => !f.harness);
	if (parsed.command === "issues") {
		for (const finding of actionable) {
			console.log(`### ${renderIssueTitle(finding)}\n\n${renderIssueBody(finding)}\n\n---\n`);
		}
		return 0;
	}

	return fileIssues(actionable, { repo: parsed.repo });
}

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
		say(created.output.trim().split("\n").pop() ?? "");
	}
	return 0;
}

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

function runGh(argv: string[]): { status: number; output: string } {
	const result = spawnSync("gh", argv, { cwd: repoRoot, encoding: "utf-8" });
	return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function readOriginRemote(): string {
	return spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoRoot, encoding: "utf-8" }).stdout ?? "";
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}

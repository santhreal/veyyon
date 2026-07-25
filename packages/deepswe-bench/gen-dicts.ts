#!/usr/bin/env bun
/**
 * Generates argot dictionaries (AGENTS.dict) for DeepSWE task repos and
 * reports the SDK's estimated savings per task.
 *
 * For each task this clones the task's repository at its base commit (shallow,
 * cached under repo-cache/), runs the argot SDK's generateDictFromRepo over
 * the tree, and writes the dictionary to dicts/<task>.AGENTS.dict.
 *
 * Those .AGENTS.dict files are an INSPECTION ARTIFACT, not an input to a run.
 * Nothing stages them into a container and no arm reads them. A run gets its
 * dictionary from the agent itself: at startup the launch project is resolved
 * and generateDictFromRepo runs over the checked-out tree into the agent's own
 * cache, outside the repository. Keep the files because reading them is the
 * quickest way to see what the generator actually chose for a repo, and delete
 * them freely; the next run regenerates its own.
 *
 * The report is the part a run depends on, because it is the task-selection
 * instrument. It is trustworthy for that purpose precisely because it calls the
 * SAME generateDictFromRepo over the SAME tree the agent will, so a task's score
 * here predicts the vocabulary the agent will really be given.
 *
 * The savings table (dicts/report.md) is also the task-selection instrument,
 * and it ranks on TYPEABLE savings, not the SDK's raw estimate. The raw estimate
 * counts every string that repeats in the repository, which is dominated by
 * license blocks, fixture YAML, and documentation URLs. Those earn handles and
 * inflate the estimate, but a coding agent never retypes them, so they cannot
 * produce a single token of real saving.
 *
 * Measured on the first run where encoding actually fired: of 33 handles, only 7
 * were ever emitted, and every one of those was whitespace-free. No prose handle
 * was emitted at all. Ranking on the raw estimate therefore overstates a repo's
 * potential by roughly three times and picked a task whose true ceiling was 0.27%
 * of output against 8.15% token noise, an experiment that could not have produced
 * a result. `typeableSavings` counts only whitespace-free handles, which never
 * misses a string the model would have written, so a near-zero value is a sound
 * reason to exclude a task before spending hours on it.
 *
 * Usage:
 *   bun gen-dicts.ts --tasks tasks/pilot-10.txt   # selected tasks
 *   bun gen-dicts.ts --all --jobs 8               # every DeepSWE task
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateDictFromRepo } from "argot";
import { OBSERVED_TYPEABLE_EMISSION_RATE, typeableHandleMass } from "./aggregate";

interface DictRow {
	task: string;
	handles: number;
	dictTokens: number;
	estimatedSavings: number;
	/** Handles whose expansion an agent could plausibly type (no whitespace). */
	typeableHandles: number;
	/**
	 * Characters saved per emission across those handles: the reachable mass, and
	 * an UPPER BOUND. It assumes every handle an agent could type is one it does.
	 */
	typeableSavings: number;
	/**
	 * `typeableSavings` scaled by the observed emission rate: what a run should
	 * actually expect. This is the column that is comparable to a measured
	 * ceiling; the one above is about seventy times larger.
	 */
	expectedSavings: number;
	error: string | null;
}

const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);
const TASKS_ROOT = path.join(BENCH_DIR, "deep-swe", "tasks");
const REPO_CACHE = path.join(BENCH_DIR, "repo-cache");
const DICTS_DIR = path.join(BENCH_DIR, "dicts");

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				out[key] = true;
			} else {
				out[key] = next;
				i++;
			}
		}
	}
	return out;
}

function taskRepoInfo(task: string): { url: string; sha: string } {
	const toml = fs.readFileSync(path.join(TASKS_ROOT, task, "task.toml"), "utf8");
	const url = toml.match(/^repository_url\s*=\s*"([^"]+)"/m)?.[1];
	const sha = toml.match(/^base_commit_hash\s*=\s*"([^"]+)"/m)?.[1];
	if (!url || !sha) throw new Error(`task.toml missing repository_url/base_commit_hash: ${task}`);
	return { url, sha };
}

async function ensureCheckout(task: string, url: string, sha: string): Promise<string> {
	const dir = path.join(REPO_CACHE, task);
	if (fs.existsSync(path.join(dir, ".git"))) return dir;
	fs.mkdirSync(dir, { recursive: true });
	const run = (args: string[]) => {
		const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args[0]} failed for ${task}: ${proc.stderr.toString().slice(0, 200)}`);
		}
		return proc.stdout.toString();
	};
	run(["init", "-q"]);
	run(["remote", "add", "origin", url]);
	try {
		run(["fetch", "-q", "--depth", "1", "origin", sha]);
	} catch {
		// Some hosts refuse arbitrary-SHA fetches; fall back to a partial clone.
		run(["fetch", "-q", "--filter=blob:none", "origin"]);
	}
	run(["checkout", "-q", sha]);
	return dir;
}

function collectFiles(dir: string): Array<{ path: string; content: string }> {
	const listing = Bun.spawnSync(["git", "ls-files"], { cwd: dir, stdout: "pipe" }).stdout.toString();
	const files: Array<{ path: string; content: string }> = [];
	for (const rel of listing.split("\n").filter(Boolean)) {
		let content = "";
		try {
			const stat = fs.statSync(path.join(dir, rel));
			if (stat.size <= 128 * 1024) content = fs.readFileSync(path.join(dir, rel), "utf8");
		} catch {
			// unreadable or non-UTF8 file: path still counts as a candidate
		}
		files.push({ path: rel, content });
	}
	return files;
}

async function genOne(task: string): Promise<DictRow> {
	try {
		const { url, sha } = taskRepoInfo(task);
		const dir = await ensureCheckout(task, url, sha);
		const files = collectFiles(dir);
		const { toml, handles, dictTokens, estimatedSavings } = generateDictFromRepo(files, {});
		if (toml) fs.writeFileSync(path.join(DICTS_DIR, `${task}.AGENTS.dict`), toml);
		const entries: Record<string, string> = {};
		for (const handle of handles) entries[handle.name] = handle.expansion;
		const mass = typeableHandleMass(entries);
		return {
			task,
			handles: handles.length,
			dictTokens,
			estimatedSavings,
			typeableHandles: mass.typeable,
			typeableSavings: mass.savingPerEmission,
			expectedSavings: mass.expectedSavingPerEmission,
			error: toml ? null : "no dictionary generated",
		};
	} catch (err) {
		return {
			task,
			handles: 0,
			dictTokens: 0,
			estimatedSavings: 0,
			typeableHandles: 0,
			typeableSavings: 0,
			expectedSavings: 0,
			error: String(err).slice(0, 200),
		};
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const jobs = Number(args.jobs ?? "8");
	let tasks: string[];
	if (args.all) {
		tasks = fs
			.readdirSync(TASKS_ROOT)
			.filter(d => fs.existsSync(path.join(TASKS_ROOT, d, "task.toml")))
			.sort();
	} else if (args.tasks) {
		tasks = fs
			.readFileSync(path.resolve(BENCH_DIR, String(args.tasks)), "utf8")
			.split("\n")
			.map(l => l.trim())
			.filter(l => l && !l.startsWith("#"));
	} else {
		console.error("pass --tasks <file> or --all");
		process.exit(1);
	}
	fs.mkdirSync(REPO_CACHE, { recursive: true });
	fs.mkdirSync(DICTS_DIR, { recursive: true });

	const queue = [...tasks];
	const rows: DictRow[] = [];
	await Promise.all(
		Array.from({ length: jobs }, async () => {
			for (;;) {
				const task = queue.shift();
				if (!task) return;
				const row = await genOne(task);
				rows.push(row);
				console.log(
					`[${rows.length}/${tasks.length}] ${task}: ${row.error ?? `handles=${row.handles} (${row.typeableHandles} typeable) typeable-saving=${row.typeableSavings}ch raw~${row.estimatedSavings}tok`}`,
				);
			}
		}),
	);

	// Rank on TYPEABLE savings. The raw SDK estimate counts prose that repeats in
	// the repo but that no agent ever writes, so ranking on it selects tasks that
	// cannot show an effect. See the header for the measurement behind this.
	rows.sort((a, b) => b.typeableSavings - a.typeableSavings);
	const lines = [
		"# Argot dictionary savings per DeepSWE task",
		"",
		`Generated ${new Date().toISOString()} by gen-dicts.ts (SDK generateDictFromRepo, default token budget).`,
		"",
		"Ranked by `typeable saving`: characters saved per emission across handles whose",
		"expansion contains no whitespace. Prose handles (license text, fixture YAML, doc",
		"URLs) repeat heavily in a repo and inflate the raw SDK estimate, but a coding",
		"agent never retypes them. On the one run measured, every handle the model emitted",
		"was whitespace-free and no prose handle ever was, so this column never misses a",
		"string the model would have written. A near-zero value means the task cannot",
		"demonstrate codec value at all, whatever the model does: exclude it before",
		"spending a run on it, and confirm the exact ceiling post-run from the bench",
		"report's Encode headroom section.",
		"",
		"READ THE `expected saving` COLUMN, NOT `typeable saving`, TO SIZE A RUN. Typeable",
		"saving assumes every handle an agent COULD type is one it DOES type, and the one",
		`run that measured both emitted 8 of 551 handles (${(100 * OBSERVED_TYPEABLE_EMISSION_RATE).toFixed(2)}%). Sizing the 16000-token`,
		"arm on the unscaled column projected a 19.07% ceiling where the run measured",
		"0.24%, and the arm could not do what it was built for. Scaled by that rate the",
		"same projection gives 0.28%, which is the right answer, so the correction is the",
		"rate and nothing else. Ranking is unaffected: a constant factor cannot reorder",
		"the table.",
		"",
		"| task | handles | typeable handles | typeable saving (ch/emission) | expected saving (ch/emission) | dict tokens | raw SDK estimate (output tok) |",
		"|---|---|---|---|---|---|---|",
		...rows.map(r =>
			r.error
				? `| ${r.task} | — | — | — | — | — | ERROR: ${r.error} |`
				: `| ${r.task} | ${r.handles} | ${r.typeableHandles} | ${r.typeableSavings} | ${r.expectedSavings} | ${r.dictTokens} | ${r.estimatedSavings} |`,
		),
		"",
	];
	fs.writeFileSync(path.join(DICTS_DIR, "report.md"), lines.join("\n"));
	fs.writeFileSync(path.join(DICTS_DIR, "report.json"), JSON.stringify(rows, null, 2));
	console.log(`\nwrote ${path.join(DICTS_DIR, "report.md")}`);
}

await main();

#!/usr/bin/env bun
/**
 * Generates argot dictionaries (AGENTS.dict) for DeepSWE task repos and
 * reports the SDK's estimated savings per task.
 *
 * For each task this clones the task's repository at its base commit (shallow,
 * cached under repo-cache/), runs the argot SDK's generateDictFromRepo over
 * the tree, and writes the dictionary to dicts/<task>.AGENTS.dict. run.ts
 * stages that file into the task container at /app/AGENTS.dict so the full
 * arm has a real dictionary to load (none/decode run with the same file
 * present but without teaching; see README).
 *
 * The savings table (dicts/report.md) is also the task-selection instrument:
 * tasks whose repos have no repeated-long-token mass show near-zero
 * estimatedSavings and cannot demonstrate codec value regardless of model
 * quality.
 *
 * Usage:
 *   bun gen-dicts.ts --tasks tasks/pilot-10.txt   # selected tasks
 *   bun gen-dicts.ts --all --jobs 8               # every DeepSWE task
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateDictFromRepo } from "argot";

interface DictRow {
	task: string;
	handles: number;
	dictTokens: number;
	estimatedSavings: number;
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
			if (next === undefined || next.startsWith("--")) out[key] = true;
			else (out[key] = next), i++;
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
		return {
			task,
			handles: handles.length,
			dictTokens,
			estimatedSavings,
			error: toml ? null : "no dictionary generated",
		};
	} catch (err) {
		return { task, handles: 0, dictTokens: 0, estimatedSavings: 0, error: String(err).slice(0, 200) };
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
					`[${rows.length}/${tasks.length}] ${task}: ${row.error ?? `handles=${row.handles} dict~${row.dictTokens}tok savings~${row.estimatedSavings}tok`}`,
				);
			}
		}),
	);

	rows.sort((a, b) => b.estimatedSavings - a.estimatedSavings);
	const lines = [
		"# Argot dictionary savings per DeepSWE task",
		"",
		`Generated ${new Date().toISOString()} by gen-dicts.ts (SDK generateDictFromRepo, default token budget).`,
		"",
		"| task | handles | dict tokens | estimated savings (output tok) |",
		"|---|---|---|---|",
		...rows.map(r =>
			r.error
				? `| ${r.task} | — | — | ERROR: ${r.error} |`
				: `| ${r.task} | ${r.handles} | ${r.dictTokens} | ${r.estimatedSavings} |`,
		),
		"",
	];
	fs.writeFileSync(path.join(DICTS_DIR, "report.md"), lines.join("\n"));
	fs.writeFileSync(path.join(DICTS_DIR, "report.json"), JSON.stringify(rows, null, 2));
	console.log(`\nwrote ${path.join(DICTS_DIR, "report.md")}`);
}

await main();

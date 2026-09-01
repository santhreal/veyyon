#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { generateDictFromRepo } from "argot";
import { OBSERVED_TYPEABLE_EMISSION_RATE, typeableHandleMass } from "./aggregate";

interface DictRow {
	task: string;
	handles: number;
	dictTokens: number;
	estimatedSavings: number;
	typeableHandles: number;
	structureHandles: number;
	typeableSavings: number;
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
		} catch {}
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
			estimatedSavings: Math.round(estimatedSavings),
			typeableHandles: mass.typeable,
			structureHandles: handles.filter(handle => handle.expansion.startsWith("\n")).length,
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
			structureHandles: 0,
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
					`[${rows.length}/${tasks.length}] ${task}: ${row.error ?? `handles=${row.handles} (${row.structureHandles} structure, ${row.typeableHandles} typeable) typeable-saving=${row.typeableSavings}ch raw~${row.estimatedSavings}tok`}`,
				);
			}
		}),
	);

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
		"was whitespace-free and no prose handle ever was.",
		"",
		"THAT COLUMN NOW COVERS A MINORITY OF THE DICTIONARY, AND THE `structure` COLUMN IS",
		'WHY. It used to be sound to read a near-zero typeable saving as "this task cannot',
		'demonstrate codec value at all", because whitespace-bearing handles were prose and',
		"prose is never retyped. The generator has since learned to mint LINE STRUCTURE",
		"(`\\n\\t\\treturn`, a bare `\\n\\t\\t`), which is whitespace-bearing and is retyped",
		"constantly, and it now dominates: measured on this repo's own trees, a 39-file",
		"TypeScript tree generates 43 handles of which 43 are structure, and a 28-file Rust",
		"tree 97 of which 95 are. So a zero in `typeable saving` no longer means the task is",
		"unmeasurable; it means the NON-STRUCTURE TAIL is unmeasurable, which is a much",
		"narrower claim. Read it that way and read `structure` beside it.",
		"",
		"The structure mass is deliberately NOT folded into the ranking, and the reason is",
		"that its sign is not known. Structure handles pay only when the model writes code",
		"inside a tool-call argument, where JSON escaping charges for every `\\t`; the same",
		"handles are net-NEGATIVE, every one of them, when the model writes a real newline",
		"in a plain message. Nothing has measured that split, so a ranking that included",
		"structure would be ranking on a number whose sign is unknown. `typeable saving`",
		"stays the sort key because it is the part that pays either way. See",
		"ARGOT-DICT-VALUE-IS-SIGNED-BY-THE-CHANNEL.",
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
		"| task | handles | structure | typeable handles | typeable saving (ch/emission) | expected saving (ch/emission) | dict tokens | raw SDK estimate (output tok) |",
		"|---|---|---|---|---|---|---|---|",
		...rows.map(r =>
			r.error
				? `| ${r.task} | — | — | — | — | — | — | ERROR: ${r.error} |`
				: `| ${r.task} | ${r.handles} | ${r.structureHandles} | ${r.typeableHandles} | ${r.typeableSavings} | ${r.expectedSavings} | ${r.dictTokens} | ${r.estimatedSavings} |`,
		),
		"",
	];
	fs.writeFileSync(path.join(DICTS_DIR, "report.md"), lines.join("\n"));
	fs.writeFileSync(path.join(DICTS_DIR, "report.json"), JSON.stringify(rows, null, 2));
	console.log(`\nwrote ${path.join(DICTS_DIR, "report.md")}`);
}

await main();

#!/usr/bin/env bun
/**
 * DeepSWE feature bench for veyyon.
 *
 * Runs the veyyon agent on DeepSWE tasks (datacurve-ai/deep-swe, Harbor task
 * format, executed by Pier) under one or more config ARMS, and writes a
 * comparison table of verifier reward + cost/performance metrics per arm.
 *
 * An arm is a veyyon config overlay (arms/<name>.yml): the only thing that
 * differs between runs. To bench a perf-affecting feature, add an arm that
 * turns it on and one that leaves it off, then run this script. See README.md.
 *
 * Usage:
 *   bun run.ts --tasks tasks/pilot-10.txt --arms baseline,decode,full \
 *     --tasks-root /path/to/deep-swe/tasks [--limit N] [--jobs 2] [--model M] \
 *     [--repeats K] [--out runs/<label>]
 *
 * --repeats K samples every (arm, task) cell K times (default 1). LLM agents are
 * stochastic, so a single sample per cell cannot separate a real arm effect from
 * run-to-run noise. The report aggregates each cell's K samples into a pass rate
 * with a binomial standard error, which is what makes the comparison something
 * you can iterate on rather than a coin flip.
 *
 * Prerequisites: pier (uv tool install datacurve-pier), docker, a compiled
 * binary at ../coding-agent/dist/vey (bun scripts/build-binary.ts there), and
 * google-antigravity OAuth in ~/.veyyon/profiles/default/shared-auth/agent.db.
 *
 * The binary, auth DB, and arm overlays are staged into <out>/assets and
 * bind-mounted into every task container at /opt/veyyon-assets (the agent
 * copies them into $HOME at run time; see pier_agent/veyyon_agent.py).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { type ArmResult, renderReport } from "./aggregate";
import { type ArmInputs, computeArmFingerprint, findZeroIvCollisions } from "./arm-fingerprint";
import { encodeArmModelMismatch } from "./treatment-guard";

const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);
const CODING_AGENT_DIR = path.resolve(BENCH_DIR, "../coding-agent");
const VEY_BINARY = path.join(CODING_AGENT_DIR, "dist", "vey");
// The bench keeps its own copy of the shared-auth DB (seed it from the host
// profile once: cp ~/.veyyon/profiles/default/shared-auth/agent.db assets/).
// The host profile is not stable storage — other veyyon lanes prune it.
const AUTH_DB = path.join(BENCH_DIR, "assets", "auth-agent.db");

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
			else out[arg.slice(2)] = argv[++i] ?? "";
		}
	}
	return out;
}

function requireFile(p: string, hint: string): void {
	if (!fs.existsSync(p)) {
		console.error(`missing: ${p}\n${hint}`);
		process.exit(1);
	}
}

// The job name is the single identifier for a container run, a config file, and a
// jobs/ subdirectory, so its format lives in exactly one pair of functions. A
// repeat suffix (`__r<n>`) is appended only when a cell is sampled more than once;
// a single-sample run keeps the historic `arm__task` name so old runs still
// reaggregate. Arm names never contain `__` and DeepSWE task names are hyphenated,
// so the first `__` splits arm from the rest and a trailing `__r<digits>` is the
// repeat index.
function jobNameOf(arm: string, task: string, repeat: number, repeats: number): string {
	return repeats > 1 ? `${arm}__${task}__r${repeat}` : `${arm}__${task}`;
}

function parseJobName(jobName: string): { arm: string; task: string; repeat: number } {
	const sep = jobName.indexOf("__");
	const arm = jobName.slice(0, sep);
	let task = jobName.slice(sep + 2);
	let repeat = 0;
	const m = task.match(/__r(\d+)$/);
	if (m) {
		repeat = Number(m[1]);
		task = task.slice(0, m.index);
	}
	return { arm, task, repeat };
}

async function ensureBinaryUpToDate(): Promise<void> {
	const srcDir = path.join(CODING_AGENT_DIR, "src");
	let needsBuild = !fs.existsSync(VEY_BINARY);
	if (!needsBuild) {
		const binaryMtime = fs.statSync(VEY_BINARY).mtimeMs;
		function checkDir(d: string): boolean {
			for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, entry.name);
				if (entry.isDirectory()) {
					if (checkDir(p)) return true;
				} else if (entry.isFile() && fs.statSync(p).mtimeMs > binaryMtime) {
					return true;
				}
			}
			return false;
		}
		needsBuild = checkDir(srcDir);
	}
	if (needsBuild) {
		console.log("deepswe-bench: building fresh vey binary...");
		const proc = Bun.spawn(["bun", "scripts/build-binary.ts"], {
			cwd: CODING_AGENT_DIR,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) {
			console.error("failed to build vey binary");
			process.exit(1);
		}
	}
}

function ensureAuthDbSeeded(): void {
	const assetsDir = path.join(BENCH_DIR, "assets");
	fs.mkdirSync(assetsDir, { recursive: true });
	if (fs.existsSync(AUTH_DB)) return;
	const candidates = [
		path.join(os.homedir(), ".veyyon", "profiles", "default", "shared-auth", "agent.db"),
		path.join(os.homedir(), ".veyyon", "profiles", "work", "shared-auth", "agent.db"),
		path.join(os.homedir(), ".veyyon", "shared-auth", "agent.db"),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			console.log(`deepswe-bench: auto-seeding auth DB from ${candidate}`);
			fs.copyFileSync(candidate, AUTH_DB);
			return;
		}
	}
}

function sha256File(p: string): string {
	return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function parseSessionsUsage(trialDir: string): Partial<ArmResult> | null {
	const sessionsDir = path.join(trialDir, "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;
	const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
	if (files.length === 0) return null;
	let inputTokens = 0,
		outputTokens = 0,
		cacheTokens = 0,
		costUsd = 0;
	let argotLoadCalls = 0,
		assistantMsgsWithSigil = 0;
	const toolCalls: Record<string, number> = {};
	for (const file of files) {
		for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: { message?: Record<string, unknown> };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const message = entry.message ?? {};
			const role = message.role;
			if (role === "assistant") {
				const usage = (message.usage ?? {}) as Record<string, number | Record<string, number>>;
				inputTokens += (usage.input as number) || 0;
				outputTokens += (usage.output as number) || 0;
				cacheTokens += ((usage.cacheRead as number) || 0) + ((usage.cacheWrite as number) || 0);
				costUsd += (usage.cost as Record<string, number>)?.total || 0;
				const content = (message.content ?? []) as Array<Record<string, unknown>>;
				if (content.some(b => typeof b === "object" && String(b.text ?? "").includes("\u00a7")))
					assistantMsgsWithSigil++;
				for (const block of content) {
					if (typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") {
						toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
					}
				}
			} else if (role === "toolResult") {
				if (message.toolName === "argot_load") argotLoadCalls++;
				if (typeof message.toolName === "string") {
					toolCalls[message.toolName] = (toolCalls[message.toolName] ?? 0) + 1;
				}
			}
		}
	}
	return { inputTokens, outputTokens, cacheTokens, costUsd, argotLoadCalls, assistantMsgsWithSigil, toolCalls };
}

function parseTrialResult(arm: string, task: string, repeat: number, jobDir: string): ArmResult {
	const result: ArmResult = {
		arm,
		task,
		repeat,
		reward: null,
		partial: null,
		f2p: null,
		p2p: null,
		inputTokens: null,
		outputTokens: null,
		cacheTokens: null,
		costUsd: null,
		agentSeconds: null,
		argotLoadCalls: null,
		assistantMsgsWithSigil: null,
		toolCalls: null,
	};
	// Pier truncates long task names in trial dir names, and a job has exactly
	// one trial, so match the single subdirectory.
	const trialDir = fs.readdirSync(jobDir, { withFileTypes: true }).find(d => d.isDirectory());
	if (!trialDir) throw new Error(`no trial dir under ${jobDir}`);
	const trialDirPath = path.join(jobDir, trialDir.name);
	const trial = JSON.parse(fs.readFileSync(path.join(trialDirPath, "result.json"), "utf8"));
	const rewards = trial.verifier_result?.rewards ?? {};
	result.reward = rewards.reward ?? null;
	result.partial = rewards.partial ?? null;
	result.f2p = rewards.f2p ?? null;
	result.p2p = rewards.p2p ?? null;
	// Usage comes from the session files themselves: pier's agent_result is
	// frozen at run time, and recomputing keeps reaggregated reports correct
	// even when the accounting code changes after a run.
	const usage = parseSessionsUsage(trialDirPath);
	if (usage) {
		result.inputTokens = usage.inputTokens ?? null;
		result.outputTokens = usage.outputTokens ?? null;
		result.cacheTokens = usage.cacheTokens ?? null;
		result.costUsd = usage.costUsd ?? null;
		result.argotLoadCalls = usage.argotLoadCalls ?? null;
		result.assistantMsgsWithSigil = usage.assistantMsgsWithSigil ?? null;
		result.toolCalls = usage.toolCalls ?? null;
	} else {
		const agent = trial.agent_result ?? {};
		result.inputTokens = agent.n_input_tokens ?? null;
		result.outputTokens = agent.n_output_tokens ?? null;
		result.cacheTokens = agent.n_cache_tokens ?? null;
		result.costUsd = agent.cost_usd ?? null;
		result.argotLoadCalls = agent.metadata?.argot_load_calls ?? null;
		result.assistantMsgsWithSigil = agent.metadata?.assistant_msgs_with_sigil ?? null;
		result.toolCalls = agent.metadata?.tool_calls ?? null;
	}
	if (trial.agent_execution?.started_at && trial.agent_execution?.finished_at) {
		result.agentSeconds =
			(Date.parse(trial.agent_execution.finished_at) - Date.parse(trial.agent_execution.started_at)) / 1000;
	}
	if (trial.exception_info) result.error = JSON.stringify(trial.exception_info).slice(0, 300);
	return result;
}

function reaggregate(runDir: string): void {
	const configDir = path.join(runDir, "configs");
	const jobsRoot = path.join(runDir, "jobs");
	const results: ArmResult[] = [];
	for (const file of fs.readdirSync(configDir).filter(f => f.endsWith(".yaml"))) {
		const jobName = file.slice(0, -".yaml".length);
		const { arm, task, repeat } = parseJobName(jobName);
		try {
			results.push(parseTrialResult(arm, task, repeat, path.join(jobsRoot, jobName)));
		} catch (err) {
			results.push({
				arm,
				task,
				repeat,
				reward: null,
				partial: null,
				f2p: null,
				p2p: null,
				inputTokens: null,
				outputTokens: null,
				cacheTokens: null,
				costUsd: null,
				agentSeconds: null,
				argotLoadCalls: null,
				assistantMsgsWithSigil: null,
				error: String(err),
			});
		}
	}
	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	let model = "unknown";
	try {
		model = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")).model ?? model;
	} catch {
		/* first aggregation */
	}
	const repeats = results.length ? Math.max(...results.map(r => r.repeat)) + 1 : 1;
	fs.writeFileSync(
		path.join(runDir, "results.json"),
		JSON.stringify({ model, arms, tasks, repeats, results }, null, 2),
	);
	fs.writeFileSync(path.join(runDir, "report.md"), renderReport(results, model, new Date().toISOString(), repeats));
	console.log(`reaggregated ${results.length} runs into ${path.join(runDir, "report.md")}`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.reaggregate) {
		reaggregate(path.resolve(args.reaggregate));
		return;
	}
	const localTasks = path.join(BENCH_DIR, "deep-swe", "tasks");
	const tasksRootArg =
		args["tasks-root"] ?? process.env.DEEPSWE_TASKS_ROOT ?? (fs.existsSync(localTasks) ? localTasks : undefined);
	if (!tasksRootArg) {
		console.error("pass --tasks-root <dir> (or clone https://github.com/datacurve-ai/deep-swe into this package)");
		process.exit(1);
	}
	const tasksRoot = path.resolve(BENCH_DIR, tasksRootArg);
	const armsArg = args.arms ?? "baseline,full";
	const arms = armsArg
		.split(",")
		.map(a => a.trim())
		.filter(Boolean);
	if (arms.length === 0) {
		console.error("error: --arms must specify at least one valid arm name");
		process.exit(1);
	}
	const model = args.model ?? "google-antigravity/gemini-3.6-flash";
	const rawRepeats = Number(args.repeats ?? "1");
	if (!Number.isFinite(rawRepeats) || rawRepeats < 1 || !Number.isInteger(rawRepeats)) {
		console.error(`error: --repeats must be a positive integer (got ${JSON.stringify(args.repeats)})`);
		process.exit(1);
	}
	const repeats = rawRepeats;
	const rawJobs = Number(args.jobs ?? "2");
	const jobParallel = Number.isFinite(rawJobs) && rawJobs > 0 ? Math.floor(rawJobs) : 2;
	const rawTrialTimeout = Number(args["trial-timeout"] ?? "900");
	const trialTimeoutSec = Number.isFinite(rawTrialTimeout) && rawTrialTimeout > 0 ? rawTrialTimeout : 900;
	const limit = args.limit ? Number(args.limit) : undefined;
	const outRoot = path.resolve(
		args.out ?? path.join(BENCH_DIR, "runs", new Date().toISOString().replace(/[:.]/g, "-")),
	);
	const taskListFile = args.tasks ? path.resolve(BENCH_DIR, args.tasks) : undefined;
	let tasks: string[];
	if (taskListFile) {
		tasks = fs
			.readFileSync(taskListFile, "utf8")
			.split("\n")
			.map(l => l.trim())
			.filter(l => l && !l.startsWith("#"));
	} else {
		tasks = fs
			.readdirSync(tasksRoot)
			.filter(d => fs.existsSync(path.join(tasksRoot, d, "task.toml")))
			.sort();
	}
	if (limit !== undefined) tasks = tasks.slice(0, limit);
	if (tasks.length === 0) {
		console.error("no tasks selected");
		process.exit(1);
	}

	await ensureBinaryUpToDate();
	ensureAuthDbSeeded();
	requireFile(VEY_BINARY, "build it: cd ../coding-agent && bun scripts/build-binary.ts");
	requireFile(AUTH_DB, "seed it: cp ~/.veyyon/profiles/default/shared-auth/agent.db assets/auth-agent.db");
	for (const arm of arms) {
		requireFile(path.join(BENCH_DIR, "arms", `${arm}.yml`), `create arms/${arm}.yml`);
	}
	for (const task of tasks) {
		requireFile(path.join(tasksRoot, task, "task.toml"), `no such DeepSWE task: ${task}`);
	}
	const pier = Bun.which("pier") ?? `${os.homedir()}/.local/bin/pier`;
	if (!fs.existsSync(pier)) {
		console.error("pier not found on PATH or ~/.local/bin — uv tool install datacurve-pier");
		process.exit(1);
	}

	const binarySha = sha256File(VEY_BINARY);

	// Stage the assets every task container sees at /opt/veyyon-assets.
	const assetsDir = path.join(outRoot, "assets");
	fs.mkdirSync(path.join(assetsDir, "arms"), { recursive: true });
	fs.copyFileSync(VEY_BINARY, path.join(assetsDir, "vey"));
	fs.chmodSync(path.join(assetsDir, "vey"), 0o755);
	fs.copyFileSync(AUTH_DB, path.join(assetsDir, "auth-agent.db"));
	// Stage each arm's config overlay, an optional per-section prompt override,
	// and an optional .rule.md, then fingerprint the exact inputs the container
	// will see. A per-section prompt experiment lives in a SEPARATE
	// arms/<arm>.sections.yml file (section -> replacement text), staged as
	// sections/<arm>.json — the exact JSON bytes the agent reads through the
	// eval-only VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS env var. It is deliberately NOT
	// a config key: no config.yml can reach it, so it cannot contaminate a normal
	// run. The fingerprint enforces the single-IV floor below: two arms may not
	// reduce to identical (config, sections, rule).
	const armFingerprints = new Map<string, string>();
	for (const arm of arms) {
		const ymlText = fs.readFileSync(path.join(BENCH_DIR, "arms", `${arm}.yml`), "utf8");
		fs.writeFileSync(path.join(assetsDir, "arms", `${arm}.yml`), ymlText);
		let config: unknown;
		try {
			config = YAML.parse(ymlText) ?? {};
		} catch (err) {
			console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.yml:\n${err}`);
			process.exit(1);
		}
		// Treatment-applies floor: an encode arm (argot on, non-empty allowlist) only
		// applies its treatment if the model under test is on that allowlist. If it is
		// not, argot silently stops encoding and the arm secretly measures decode-only
		// while still being labelled as the encode condition — a Law-10 silent fallback
		// inside the eval set. Refuse to run it, using argot's OWN matching rule.
		const mismatch = encodeArmModelMismatch(config, model);
		if (mismatch !== null) {
			console.error(
				`error: arm "${arm}" enables argot encoding with an allowlist that does not\n` +
					`include the model under test, so it would SILENTLY degrade to decode-only\n` +
					`and measure the wrong condition:\n` +
					`  arms/${arm}.yml argot.models = [${mismatch.join(", ")}]\n` +
					`  --model = ${model}\n` +
					`Fix: add the model to arms/${arm}.yml argot.models (a bare name like\n` +
					`"${model.slice(model.lastIndexOf("/") + 1)}" matches any provider), or bench a --model the arm\n` +
					`already lists, or use arms/decode.yml if you meant the decode-only condition.`,
			);
			process.exit(1);
		}
		let sections: unknown;
		const sectionsPath = path.join(BENCH_DIR, "arms", `${arm}.sections.yml`);
		if (fs.existsSync(sectionsPath)) {
			try {
				sections = YAML.parse(fs.readFileSync(sectionsPath, "utf8")) ?? {};
			} catch (err) {
				console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.sections.yml:\n${err}`);
				process.exit(1);
			}
			if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
				console.error(
					`error: arm "${arm}" arms/${arm}.sections.yml must be a mapping of section -> replacement text, ` +
						`got ${Array.isArray(sections) ? "a sequence" : typeof sections}.`,
				);
				process.exit(1);
			}
			fs.mkdirSync(path.join(assetsDir, "sections"), { recursive: true });
			// Stage the exact JSON the env var will carry (compact, deterministic).
			fs.writeFileSync(path.join(assetsDir, "sections", `${arm}.json`), JSON.stringify(sections));
		}
		let rule: Uint8Array | undefined;
		const rulePath = path.join(BENCH_DIR, "arms", `${arm}.rule.md`);
		if (fs.existsSync(rulePath)) {
			rule = fs.readFileSync(rulePath);
			fs.mkdirSync(path.join(assetsDir, "rules"), { recursive: true });
			fs.writeFileSync(path.join(assetsDir, "rules", `${arm}.md`), rule);
		}
		const mod: ArmInputs = {
			config,
			...(sections !== undefined ? { sections } : {}),
			...(rule !== undefined ? { rule } : {}),
		};
		armFingerprints.set(arm, computeArmFingerprint(mod));
	}
	// Single-IV floor: a controlled comparison must vary exactly one independent
	// variable (README, "Single Independent Variable Rule"). Byte-identical arms
	// vary ZERO, so every delta between them is noise — the silent no-op arm
	// (candidate-vN copied from baseline with nothing changed). Fail loudly with
	// the exact collision rather than emit a result-shaped table with no cause.
	if (arms.length >= 2) {
		const collisions = findZeroIvCollisions(armFingerprints);
		if (collisions.length > 0) {
			const detail = collisions.map(group => `  {${group.join(", ")}} reduce to identical inputs`).join("\n");
			console.error(
				"error: zero-IV arm collision — a controlled comparison must vary exactly one\n" +
					"independent variable, but these arms reduce to the same (config, sections, rule),\n" +
					`so every delta between them is noise:\n${detail}\n` +
					"Fix: give each arm a distinct config, a distinct .sections.yml, or a distinct\n" +
					".rule.md, or drop the redundant arm from --arms. See README 'Single Independent\n" +
					"Variable Rule'.",
			);
			process.exit(1);
		}
	}

	const results: ArmResult[] = [];
	const queue: Array<{ arm: string; task: string; repeat: number }> = arms.flatMap(arm =>
		tasks.flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ arm, task, repeat }))),
	);

	console.log(
		`deepswe-bench: ${arms.length} arm(s) x ${tasks.length} task(s)` +
			`${repeats > 1 ? ` x ${repeats} repeat(s)` : ""} = ${queue.length} run(s), model ${model}`,
	);
	console.log(`assets: ${assetsDir} (binary sha256 ${binarySha.slice(0, 12)}) → jobs under ${outRoot}`);

	function writeJobConfig(arm: string, task: string, repeat: number): string {
		const jobName = jobNameOf(arm, task, repeat, repeats);
		const configDir = path.join(outRoot, "configs");
		fs.mkdirSync(configDir, { recursive: true });
		const configPath = path.join(configDir, `${jobName}.yaml`);
		const yaml = [
			`job_name: ${jobName}`,
			`jobs_dir: ${path.join(outRoot, "jobs")}`,
			"quiet: true",
			"n_concurrent_trials: 1",
			"tasks:",
			`  - path: ${path.join(tasksRoot, task)}`,
			"agents:",
			"  - import_path: veyyon_agent:VeyyonAgent",
			`    model_name: ${model}`,
			"    kwargs:",
			`      arm_name: ${arm}`,
			`      assets_dir: ${assetsDir}`,
			`      binary_sha: ${binarySha}`,
			`      prompt_template_path: ${path.join(BENCH_DIR, "pier_agent", "oneshot_prompt.md.j2")}`,
			"",
		].join("\n");
		fs.writeFileSync(configPath, yaml);
		return configPath;
	}

	async function runOne(arm: string, task: string, repeat: number, attempt = 1): Promise<void> {
		const jobName = jobNameOf(arm, task, repeat, repeats);
		const jobDir = path.join(outRoot, "jobs", jobName);
		if (attempt > 1 && fs.existsSync(jobDir)) {
			fs.rmSync(jobDir, { recursive: true, force: true });
			try {
				await Bun.spawn(["sh", "-c", `docker rm -f $(docker ps -aq --filter name=${jobName}) 2>/dev/null || true`])
					.exited;
				await Bun.spawn(["docker", "network", "prune", "-f"]).exited;
			} catch {
				/* best effort */
			}
		}
		const started = Date.now();
		const proc = Bun.spawn([pier, "run", "-c", writeJobConfig(arm, task, repeat), "-q"], {
			cwd: path.join(BENCH_DIR, "pier_agent"),
			env: { ...process.env, PYTHONPATH: path.join(BENCH_DIR, "pier_agent") },
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, trialTimeoutSec * 1000);

		const exitCode = await proc.exited;
		clearTimeout(timer);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		let result: ArmResult;
		try {
			if (timedOut) throw new Error(`trial timed out after ${trialTimeoutSec}s`);
			result = parseTrialResult(arm, task, repeat, jobDir);
		} catch (err) {
			const errStr = `${err}; pier exit ${exitCode}; ${stderr.slice(-300) || stdout.slice(-300)}`;
			if (
				attempt === 1 &&
				!timedOut &&
				(errStr.includes("Docker compose command failed") ||
					errStr.includes("FileExistsError") ||
					errStr.includes("ENOENT"))
			) {
				console.log(
					`[retry] ${jobName} hit container startup collision; pruning docker network & retrying (attempt 2)...`,
				);
				return await runOne(arm, task, repeat, 2);
			}
			result = {
				arm,
				task,
				repeat,
				reward: null,
				partial: null,
				f2p: null,
				p2p: null,
				inputTokens: null,
				outputTokens: null,
				cacheTokens: null,
				costUsd: null,
				agentSeconds: null,
				argotLoadCalls: null,
				assistantMsgsWithSigil: null,
				toolCalls: null,
				error: errStr,
			};
		}
		results.push(result);
		const mark = result.error ? "ERROR" : result.reward === 1 ? "pass" : `reward=${result.reward}`;
		console.log(
			`[${results.length}/${queue.length}] ${jobName}: ${mark} out=${result.outputTokens ?? "?"}tok cost=$${result.costUsd?.toFixed(3) ?? "?"} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
		);
	}

	// Small bounded pool: task containers take 2 cpu / 8 GB each.
	const workers = Array.from({ length: Math.max(1, jobParallel) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			await runOne(next.arm, next.task, next.repeat);
		}
	});
	await Promise.all(workers);

	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	fs.writeFileSync(
		path.join(outRoot, "results.json"),
		JSON.stringify({ model, binarySha, arms, tasks, repeats, results }, null, 2),
	);
	fs.writeFileSync(path.join(outRoot, "report.md"), renderReport(results, model, new Date().toISOString(), repeats));
	console.log(`\nwrote ${path.join(outRoot, "report.md")} and results.json`);
}

await main();

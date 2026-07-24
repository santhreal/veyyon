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
 * with a 95% Wilson confidence interval, which is what makes the comparison
 * something you can iterate on rather than a coin flip.
 *
 * Every arm runs at a pinned sampling temperature (0, greedy) unless it sets its
 * own, so --repeats measures a stable regime instead of a drifting provider
 * default; the effective temperature per arm is stamped into results.json so two
 * runs stay comparable over time.
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
import {
	type ArmResult,
	effectiveTemperature,
	jobNameOf,
	PINNED_TEMPERATURE,
	parseJobName,
	providerFinishReason,
	renderReport,
	type SessionUsage,
	selectTasks,
	systemPromptTeachesArgot,
	tallyUsage,
} from "./aggregate";
import { type ArmInputs, computeArmFingerprint, findZeroIvCollisions } from "./arm-fingerprint";
import { encodeArmModelMismatch, encodePreambleSilentlyDropped, isEncodeArm } from "./treatment-guard";

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

/**
 * Parse a trial's session jsonl(s) into token/tool usage AND whether the argot
 * encode preamble actually reached the model.
 *
 * `preambleTaught` reads the `session_init` entry's `systemPrompt` (a top-level
 * jsonl entry, NOT an `entry.message`) so it reflects the prompt the model was
 * really given, after catalog id resolution. `null` when no `session_init` with a
 * system prompt was seen (presence unknown), `true`/`false` otherwise. This is the
 * authoritative treatment-applied signal (see `systemPromptTeachesArgot`).
 */
function parseSessionsUsage(trialDir: string): { usage: SessionUsage; preambleTaught: boolean | null } | null {
	const sessionsDir = path.join(trialDir, "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;
	const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
	if (files.length === 0) return null;
	// Read every session line into its message object; the pure tallyUsage does the
	// counting (and the once-per-tool fix) so the same logic is unit-tested. The
	// same pass reads the session_init system prompt for the preamble probe.
	const messages: Array<Record<string, unknown>> = [];
	let preambleTaught: boolean | null = null;
	for (const file of files) {
		for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as {
					message?: Record<string, unknown>;
					type?: string;
					systemPrompt?: unknown;
				};
				if (entry.message) messages.push(entry.message);
				if (entry.type === "session_init" && typeof entry.systemPrompt === "string") {
					// Any session_init that taught the preamble means encode fired; only
					// downgrade to false when a system prompt was seen and none taught it.
					preambleTaught = preambleTaught === true || systemPromptTeachesArgot(entry.systemPrompt);
				}
			} catch {
				// A truncated final line (a killed run) is not a parse we can trust.
			}
		}
	}
	return { usage: tallyUsage(messages), preambleTaught };
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
		argotPreamblePresent: null,
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
	const parsed = parseSessionsUsage(trialDirPath);
	if (parsed) {
		const { usage } = parsed;
		result.inputTokens = usage.inputTokens ?? null;
		result.outputTokens = usage.outputTokens ?? null;
		result.cacheTokens = usage.cacheTokens ?? null;
		result.costUsd = usage.costUsd ?? null;
		result.argotLoadCalls = usage.argotLoadCalls ?? null;
		result.assistantMsgsWithSigil = usage.assistantMsgsWithSigil ?? null;
		result.argotPreamblePresent = parsed.preambleTaught;
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
	if (trial.exception_info) {
		let err = JSON.stringify(trial.exception_info).slice(0, 300);
		// pier's exception_info carries the failed command, not WHY the model
		// stopped. A provider content-filter stop (finish reason PROHIBITED_CONTENT /
		// SAFETY / RECITATION) is written to the agent's own log, so read its tail and
		// fold the finish reason into the error. This lets classifyError separate a
		// provider refusal from a genuine crash — an asymmetry that would otherwise be
		// invisible and could silently bias an arm comparison.
		const agentLog = path.join(trialDirPath, "agent", "veyyon.txt");
		if (fs.existsSync(agentLog)) {
			const tail = fs.readFileSync(agentLog, "utf8").slice(-2000);
			const finish = providerFinishReason(tail);
			if (finish) err += ` finish_reason: ${finish}`;
		}
		result.error = err;
	}
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
				argotPreamblePresent: null,
				toolCalls: null,
				error: String(err),
			});
		}
	}
	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	let model = "unknown";
	// Preserve the subset provenance the original run recorded (which tasks were
	// sampled, out of how many): a reaggregate re-derives `tasks` from the jobs on
	// disk, so without carrying these forward the "this was a limited subset" signal
	// would silently vanish from the re-rendered results.json.
	let limit: number | null = null;
	let totalTasksAvailable: number | null = null;
	// Carry the recorded sampling regime forward too: a reaggregate does not re-stage
	// arm configs, so it cannot re-derive the temperature that was actually run. Losing
	// it would silently drop the regime provenance from the re-rendered results.json.
	let sampling: unknown = null;
	// The arm fingerprints and binary sha likewise cannot be re-derived from the jobs
	// on disk (a reaggregate does not re-stage), so carry them forward or the run
	// stops being self-identifying after a re-render.
	let armFingerprints: unknown = null;
	let binarySha: string | null = null;
	try {
		const prior = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
		model = prior.model ?? model;
		limit = prior.limit ?? null;
		totalTasksAvailable = prior.totalTasksAvailable ?? null;
		sampling = prior.sampling ?? null;
		armFingerprints = prior.armFingerprints ?? null;
		binarySha = prior.binarySha ?? null;
	} catch {
		/* first aggregation */
	}
	const repeats = results.length ? Math.max(...results.map(r => r.repeat)) + 1 : 1;
	fs.writeFileSync(
		path.join(runDir, "results.json"),
		JSON.stringify(
			{ model, binarySha, limit, totalTasksAvailable, sampling, armFingerprints, arms, tasks, repeats, results },
			null,
			2,
		),
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
	// Default to the RESOLVED logical id (`gemini-3.5-flash`), not the display alias
	// `gemini-3.6-flash`. On google-antigravity the catalog serves the flash family
	// under logical id `gemini-3.5-flash` with `gemini-3.6-flash` as an alias, so a
	// requested `.../gemini-3.6-flash` runs as logical `.../gemini-3.5-flash`. Keeping
	// requested == resolved is what lets an encode arm's allowlist match the model the
	// gate actually sees; the post-run preamble check fails the run closed if it drifts.
	const model = args.model ?? "google-antigravity/gemini-3.5-flash";
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
	let limit: number | undefined;
	if (args.limit !== undefined) {
		const parsedLimit = Number(args.limit);
		if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
			console.error(`error: --limit must be a positive integer (got ${JSON.stringify(args.limit)})`);
			process.exit(1);
		}
		limit = parsedLimit;
	}
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
	const totalTasksAvailable = tasks.length;
	if (limit !== undefined && limit < totalTasksAvailable) {
		// Even-stride representative subsample, not the alphabetically-first N (which
		// would cluster on the first repo prefix and bias the pass rate). Loud, because
		// a limited run's pass rate is an estimate over a SUBSET, not the full suite,
		// and must never be read as the headline number.
		tasks = selectTasks(tasks, limit);
		console.error(
			`note: --limit ${limit} selects ${tasks.length} of ${totalTasksAvailable} tasks as an even-stride ` +
				`representative sample; the reported pass rate covers this subset, not the full suite ` +
				`(the exact task list is recorded in results.json).`,
		);
	}
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
	const armTemperature = new Map<string, number>();
	// Arms that declare an ENCODE treatment (argot on, non-empty allowlist). After
	// the run, every such arm MUST have actually taught the encode preamble to the
	// model, or it silently degraded to decode-only and measured the wrong condition
	// (the pre-run allowlist guard cannot catch a post-resolution model mismatch).
	const encodeArms = new Set<string>();
	for (const arm of arms) {
		const ymlText = fs.readFileSync(path.join(BENCH_DIR, "arms", `${arm}.yml`), "utf8");
		let config: unknown;
		try {
			config = YAML.parse(ymlText) ?? {};
		} catch (err) {
			console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.yml:\n${err}`);
			process.exit(1);
		}
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml must be a mapping of setting -> value, ` +
					`got ${Array.isArray(config) ? "a sequence" : typeof config}.`,
			);
			process.exit(1);
		}
		// Pin the sampling temperature identically for every arm (unless the arm sets
		// its own for a deliberate temperature-as-IV experiment) so `--repeats`
		// measures a stable regime instead of a drifting provider default, and stamp
		// the effective value into results.json below. Injecting it into the parsed
		// config BEFORE fingerprinting keeps the single-IV floor intact: the same
		// value goes into every arm, so it never becomes a spurious difference, and
		// the staged file the container reads matches exactly what was fingerprinted.
		const temperature = effectiveTemperature(config);
		(config as Record<string, unknown>).temperature = temperature;
		armTemperature.set(arm, temperature);
		if (isEncodeArm(config)) encodeArms.add(arm);
		fs.writeFileSync(path.join(assetsDir, "arms", `${arm}.yml`), YAML.stringify(config));
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
	const overrides = arms.filter(a => (armTemperature.get(a) ?? PINNED_TEMPERATURE) !== PINNED_TEMPERATURE);
	console.log(
		`sampling: temperature pinned to ${PINNED_TEMPERATURE} (greedy) for every arm, stamped into results.json` +
			(overrides.length > 0
				? `; arm(s) with an explicit override: ${overrides.map(a => `${a}=${armTemperature.get(a)}`).join(", ")}`
				: ""),
	);

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
				argotPreamblePresent: null,
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
		JSON.stringify(
			{
				model,
				binarySha,
				limit: limit ?? null,
				totalTasksAvailable,
				sampling: {
					pinnedTemperature: PINNED_TEMPERATURE,
					perArm: Object.fromEntries(arms.map(a => [a, armTemperature.get(a) ?? PINNED_TEMPERATURE])),
					note: "greedy at temperature 0: top-p / top-k are irrelevant, so temperature alone fixes the regime",
				},
				// The semantic fingerprint of each arm's exact (config, sections, rule)
				// inputs — the same value the zero-IV guard uses. Stamping it makes every
				// run self-identifying: two runs of an arm with the same name but a changed
				// config produce different fingerprints, so a longitudinal diff catches the
				// drift instead of silently comparing two different treatments.
				armFingerprints: Object.fromEntries(arms.map(a => [a, armFingerprints.get(a) ?? null])),
				arms,
				tasks,
				repeats,
				results,
			},
			null,
			2,
		),
	);
	fs.writeFileSync(path.join(outRoot, "report.md"), renderReport(results, model, new Date().toISOString(), repeats));
	console.log(`\nwrote ${path.join(outRoot, "report.md")} and results.json`);

	// Authoritative post-run treatment check. The pre-run allowlist guard matched the
	// REQUESTED --model, but the runtime resolves that id through the catalog (provider
	// aliases, effort-tier collapsing) to a different logical id before argot's encode
	// gate runs. So an encode arm can pass the pre-run guard yet run decode-only if the
	// RESOLVED model fell off the allowlist. Read whether the preamble actually reached
	// the model (from the session system prompt) and FAIL CLOSED if an encode arm never
	// taught it: a silent decode-only degrade makes every token delta against that arm
	// measure nothing, so the run is invalid and must not be reported as sound.
	const degraded: string[] = [];
	for (const arm of encodeArms) {
		const flags = results.filter(r => r.arm === arm && !r.error).map(r => r.argotPreamblePresent);
		if (encodePreambleSilentlyDropped(flags)) degraded.push(arm);
	}
	if (degraded.length > 0) {
		console.error(
			`\nerror: encode arm(s) [${degraded.join(", ")}] never taught the argot preamble in ANY\n` +
				`OK trial, so they SILENTLY ran decode-only and every token delta against them is inert.\n` +
				`The likely cause is a model-id resolution mismatch: the requested --model = ${model}\n` +
				`resolves through the catalog to a different logical id that is not on the arm's\n` +
				`argot.models allowlist. Check the run's session_init model vs arms/<arm>.yml argot.models,\n` +
				`and set the allowlist to the RESOLVED logical id (see report.md "Argot treatment applied?").`,
		);
		process.exitCode = 1;
	}
}

await main();

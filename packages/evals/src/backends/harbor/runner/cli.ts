/**
 * CLI entry point for the Harbor benchmark runner: argument parsing, resume
 * configuration resolution, benchmark execution, and exit code mapping.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, isRecord, tryParseJson } from "@veyyon/utils";
import { requireHarness } from "../../../core/harness-registry";
import { requireHarborBinding } from "../backend";
import { buildHarborArgs, harborRunnerArgs, type LaunchRequest } from "../launch-args";
import { runDockerCleanup } from "./cleanup";
import {
	buildHarborEnv,
	buildResumeArgs,
	type Config,
	DEFAULT_HARBOR_DATASET,
	DOCKER_GATEWAY_URL,
	defaultConfig,
	VMNET_GATEWAY_URL,
} from "./config";
import { buildTarball, newestTarball, prepareSourceDeps, readPkgVersion, type SourceMount } from "./deps";
import { gatewayHealthOk, startVmnetGatewayForward, writeModelsYaml } from "./gateway";
import { buildMountsJson, writeComposeOverlay } from "./mounts";
import { aggregate, readJobResult, readTrials, type Totals } from "./results";
import {
	bold,
	CSI,
	dim,
	fmtDur,
	fmtNum,
	fmtUsd,
	green,
	type RenderState,
	red,
	render,
	writeReport,
	yellow,
} from "./ui";

const isTTY = Boolean(process.stdout.isTTY);

export const HELP = `evals harbor runner (local veyyon)

Usage:
  bun packages/evals/src/backends/harbor/runner/cli.ts [options]
  bun packages/evals/src/backends/harbor/runner/cli.ts cleanup

Options:
  -m, --model <id>               Model to benchmark (repeatable; required)
  -d, --dataset <name>           Harbor dataset (default: ${DEFAULT_HARBOR_DATASET})
  -l, --tasks <n>                Number of tasks to run (default: 20)
  -n, --concurrency <n>          Concurrent tasks (default: 4)
  -k, --attempts <n>             Attempts per task (default: 1)
  -i, --include <pattern>        Filter task names (repeatable)
  -x, --exclude <pattern>        Exclude task names (repeatable)
      --thinking <level>         Thinking level (off|minimal|low|medium|high|max)
      --agent-arg <arg>          Extra arg forwarded to in-container veyyon CLI (repeatable)
      --agent <name>             Agent adapter name (default: veyyon; e.g. oracle, nop)
      --install <mode>           Install mode: source | local | published (default: source)
      --version <v>              Target version string (default: package.json version)
      --tarball <path>           Use pre-built tarball (sets --install local --no-build)
      --binary <path>            Use pre-built binary (arm64 or x64 inferred from filename)
      --no-build                 Skip bun pm pack, use newest existing tarball in jobs dir
      --gateway-url <url>        Host auth gateway URL (default: ${DOCKER_GATEWAY_URL})
      --gateway-token <tok>      Auth gateway bearer token (default: no-auth)
      --providers <p1,p2>        Providers routed via gateway
      --no-gateway               Disable gateway routing; pass host provider keys directly
      --web-search               Enable veyyon web search in task containers
  -o, --jobs-dir <dir>           Directory to write job runs (default: packages/evals/.runs/harbor)
      --job-name <name>          Custom job name (default: <model>-<timestamp>)
      --resume <job>             Resume an existing job: keep completed trials, re-run rest
      --filter-error-type <t>    With --resume: re-run trials that errored with this exception
      --environment <backend>    Container backend: docker | apple-container (default: docker)
      --dry-run                  Print the harbor invocation, models.yml and env, then exit
      --cleanup                  Clean up leftover Harbor Docker containers/networks before running
      --cleanup-force            Force-kill and remove ALL Harbor Docker containers/networks before running
      --timeout-multiplier <n>   Multiply task timeouts by N (e.g. 1.5 for slow models)
  -y, --yes                      Non-interactive: auto-accept dataset download prompts
  -e, --env <KEY[=VAL]>          Forward host env var to task container (repeatable)
      --host-network             Run Docker task containers using host networking (experimental)
  -h, --help                     This help
`;

export class HelpRequestedError extends Error {
	constructor() {
		super("Help requested");
		this.name = "HelpRequestedError";
	}
}

export class HarborConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarborConfigError";
	}
}

export class HarborPrerequisiteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarborPrerequisiteError";
	}
}

export class GatewayHealthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayHealthError";
	}
}

export class HarborExecutionError extends Error {
	readonly exitCode: number;
	constructor(exitCode: number, message: string) {
		super(message);
		this.name = "HarborExecutionError";
		this.exitCode = exitCode;
	}
}

function readJson(file: string): unknown {
	try {
		return tryParseJson(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function which(bin: string): string | null {
	const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
	const out = r.stdout?.trim();
	return r.status === 0 && out ? out : null;
}

export function parseArgs(argv: string[], options?: { defaultDataset?: string }): Config {
	const cfg = defaultConfig(options);
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (arg === "--") {
			cfg.passthrough.push(...argv.slice(i + 1));
			break;
		}
		let inlineValue: string | null = null;
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (eq !== -1) {
			inlineValue = arg.slice(eq + 1);
			arg = arg.slice(0, eq);
		}
		const take = (flag: string): string => {
			if (inlineValue !== null) return inlineValue;
			const v = argv[i + 1];
			if (v === undefined) throw new HarborConfigError(`missing value for ${flag}`);
			i++;
			return v;
		};
		switch (arg) {
			case "-m":
			case "--model":
				cfg.models.push(take(arg));
				break;
			case "--agent":
				cfg.agent = take(arg);
				break;
			case "--install": {
				const v = take(arg);
				if (v !== "source" && v !== "local" && v !== "published") {
					throw new HarborConfigError("--install must be source|local|published");
				}
				cfg.install = v;
				break;
			}
			case "--version":
				cfg.version = take(arg);
				break;
			case "--thinking":
				cfg.thinking = take(arg);
				break;
			case "--tarball":
				cfg.tarball = path.resolve(take(arg));
				cfg.install = "local";
				cfg.build = false;
				break;
			case "--binary": {
				const p = path.resolve(take(arg));
				const base = path.basename(p);
				if (/arm64|aarch64/.test(base)) cfg.binaryArm64 = p;
				else if (/x64|x86[_-]?64|amd64/.test(base)) cfg.binaryX64 = p;
				else throw new HarborConfigError(`--binary: cannot infer arch from ${base} (expect arm64/x64 in filename)`);
				cfg.build = false;
				break;
			}
			case "--no-build":
				cfg.build = false;
				break;
			case "--agent-arg":
				cfg.agentArgs.push(take(arg));
				break;
			case "-l":
			case "--tasks":
			case "--n-tasks":
				cfg.tasks = Number(take(arg));
				break;
			case "-n":
			case "--concurrency":
			case "--n-concurrent":
				cfg.concurrency = Number(take(arg));
				break;
			case "-k":
			case "--attempts":
			case "--n-attempts":
				cfg.attempts = Number(take(arg));
				break;
			case "-i":
			case "--include":
				cfg.include.push(take(arg));
				break;
			case "-x":
			case "--exclude":
				cfg.exclude.push(take(arg));
				break;
			case "-d":
			case "--dataset":
				cfg.dataset = take(arg);
				break;
			case "--gateway-url":
				cfg.gatewayUrl = take(arg);
				break;
			case "--gateway-token":
				cfg.gatewayToken = take(arg);
				break;
			case "--providers":
				cfg.providers.push(
					...take(arg)
						.split(",")
						.map(s => s.trim())
						.filter(Boolean),
				);
				break;
			case "--no-gateway":
				cfg.gateway = false;
				break;
			case "--web-search":
				cfg.webSearch = true;
				break;
			case "--allow-host":
				cfg.allowHosts.push(take(arg));
				break;
			case "-o":
			case "--jobs-dir":
				cfg.jobsDir = path.resolve(take(arg));
				break;
			case "--job-name":
				cfg.jobName = take(arg);
				break;
			case "--resume":
				cfg.resume = take(arg);
				break;
			case "--filter-error-type":
				cfg.filterErrorTypes.push(take(arg));
				break;
			case "--timeout-multiplier":
				cfg.timeoutMultiplier = Number(take(arg));
				break;
			case "--dry-run":
				cfg.dryRun = true;
				break;
			case "--cleanup":
				cfg.cleanup = true;
				break;
			case "--cleanup-force":
				cfg.cleanupForce = true;
				break;
			case "--host-network":
				cfg.hostNetwork = true;
				break;
			case "-y":
			case "--yes":
				cfg.yes = true;
				break;
			case "-h":
			case "--help":
				throw new HelpRequestedError();
			case "-e":
			case "--env": {
				const spec = take(arg);
				const eq2 = spec.indexOf("=");
				if (eq2 === -1) {
					const hostVal = process.env[spec];
					if (hostVal !== undefined) cfg.env[spec] = hostVal;
				} else {
					cfg.env[spec.slice(0, eq2)] = spec.slice(eq2 + 1);
				}
				break;
			}
			case "--environment": {
				const v = take(arg);
				if (v !== "docker" && v !== "apple-container") {
					throw new HarborConfigError("--environment must be docker|apple-container");
				}
				cfg.envType = v;
				break;
			}
			default:
				throw new HarborConfigError(`unknown flag: ${arg} (see --help)`);
		}
	}
	if (cfg.models.length === 0 && !cfg.resume) {
		throw new HarborConfigError("--model <provider/model-id> is required (see --help)");
	}
	if (cfg.envType === "apple-container") {
		if (cfg.hostNetwork) throw new HarborConfigError("--host-network is docker-only (compose overlay)");
		if (cfg.gatewayUrl === DOCKER_GATEWAY_URL) cfg.gatewayUrl = VMNET_GATEWAY_URL;
	}
	return cfg;
}

interface ManagerRecord {
	benchmark?: string;
	dataset?: string;
	config?: LaunchRequest;
}

export function resolveResumeConfig(cli: Config): Config {
	const spec = cli.resume as string;
	const jobsDir = spec.includes(path.sep) ? path.dirname(path.resolve(spec)) : cli.jobsDir;
	const jobName = path.basename(spec);
	const jobDir = path.join(jobsDir, jobName);
	const jobConfig = readJson(path.join(jobDir, "config.json")) as { environment?: { type?: string } } | null;
	if (!jobConfig) throw new HarborConfigError(`--resume: ${jobDir} has no harbor config.json (not a harbor job dir)`);

	let cfg: Config | null = null;
	const saved = readJson(path.join(jobsDir, "_bench", jobName, "runner-config.json"));
	if (saved && typeof saved === "object") {
		cfg = { ...defaultConfig(), ...(saved as Partial<Config>) };
	} else {
		const manager = readJson(path.join(jobDir, "manager.json")) as ManagerRecord | null;
		if (manager?.config) {
			if (manager.benchmark && manager.benchmark !== "harbor") {
				throw new HarborConfigError(`--resume supports only harbor runs (${jobName} is ${manager.benchmark})`);
			}
			const dataset = manager.config.dataset ?? manager.dataset ?? "terminal-bench@2.0";
			cfg = parseArgs(harborRunnerArgs(manager.config, { jobsDir, jobName, dataset }));
		}
	}
	if (!cfg) {
		throw new HarborConfigError(
			`--resume: no recorded launch config for ${jobName} ` +
				`(missing both _bench/${jobName}/runner-config.json and ${jobName}/manager.json)`,
		);
	}
	cfg.jobsDir = jobsDir;
	cfg.jobName = jobName;
	cfg.resume = spec;
	if (cfg.models.length === 0) {
		throw new HarborConfigError(
			`--resume: the recorded launch config for ${jobName} names no model, so the resumed trials would ` +
				`report an unnamed model's result. Relaunch with --model <provider/model-id>.`,
		);
	}
	const recorded = jobConfig.environment?.type;
	if ((recorded === "docker" || recorded === "apple-container") && cfg.envType !== recorded) {
		if (recorded === "apple-container" && cfg.gatewayUrl === DOCKER_GATEWAY_URL) cfg.gatewayUrl = VMNET_GATEWAY_URL;
		else if (recorded === "docker" && cfg.gatewayUrl === VMNET_GATEWAY_URL) cfg.gatewayUrl = DOCKER_GATEWAY_URL;
		cfg.envType = recorded;
	}
	cfg.filterErrorTypes = cli.filterErrorTypes;
	cfg.passthrough = cli.passthrough;
	cfg.dryRun = cli.dryRun;
	cfg.cleanup = cli.cleanup;
	cfg.cleanupForce = cli.cleanupForce;
	return cfg;
}

export interface BenchmarkRun {
	exitCode: number;
	jobName: string;
	jobDir: string;
	benchDir: string;
	tarball: string | null;
	elapsedMs: number;
	totals: Totals | null;
	reportPath: string | null;
}

export async function runBenchmark(cfg: Config): Promise<BenchmarkRun> {
	if (!which("harbor")) {
		throw new HarborPrerequisiteError("harbor not found on PATH. Install with: uv tool install harbor");
	}
	const harness = requireHarness(cfg.agent);
	const binding = requireHarborBinding(harness);

	if (binding.requiresDocker && cfg.envType === "docker" && !which("docker")) {
		throw new HarborPrerequisiteError("docker not found on PATH (required to run task containers).");
	}
	if (cfg.envType === "apple-container" && !which("container")) {
		throw new HarborPrerequisiteError(
			"Apple 'container' CLI not found. Install with: brew install container && container system start",
		);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const modelSlug = (cfg.models[0] ?? "model").replace(/[^a-zA-Z0-9]+/g, "-");
	const jobName = cfg.jobName ?? `${modelSlug}-${stamp}`;
	const jobDir = path.join(cfg.jobsDir, jobName);
	const benchDir = path.join(cfg.jobsDir, "_bench", jobName);
	fs.mkdirSync(benchDir, { recursive: true });
	if (!cfg.resume && !cfg.dryRun) {
		fs.writeFileSync(path.join(benchDir, "runner-config.json"), JSON.stringify({ ...cfg, jobName }, null, "\t"));
	}

	const version = readPkgVersion();

	let tarball: string | null = cfg.tarball;
	if (binding.localTarball && cfg.install === "local" && !cfg.binaryArm64 && !cfg.binaryX64) {
		if (tarball) {
			process.stdout.write(dim(`using tarball ${tarball}\n`));
		} else if (cfg.build) {
			tarball = buildTarball(path.join(cfg.jobsDir, "_bench"));
		} else {
			tarball = newestTarball(path.join(cfg.jobsDir, "_bench"));
			if (!tarball)
				throw new HarborPrerequisiteError("--no-build but no tarball found; pass --tarball or drop --no-build");
		}
	}

	let source: SourceMount | null = null;
	if (binding.sourceMount && cfg.install === "source" && !cfg.binaryArm64 && !cfg.binaryX64) {
		source = prepareSourceDeps(cfg);
	}

	let modelsYaml = "";
	if (binding.authGateway && cfg.gateway) {
		modelsYaml = writeModelsYaml(benchDir, cfg);
		if (!gatewayHealthOk(cfg.gatewayUrl)) {
			throw new GatewayHealthError(
				`Auth gateway at ${cfg.gatewayUrl} is not answering /healthz. Start it on the host with ` +
					"`vey auth-broker serve` and `vey auth-gateway serve --no-auth --bind 127.0.0.1:4000`, " +
					"or pass --no-gateway to forward host provider keys into the containers instead.",
			);
		}
	}
	const composeOverlayPath = cfg.envType === "docker" ? writeComposeOverlay(benchDir, cfg, source) : null;
	const mountsJson = cfg.envType === "docker" ? null : buildMountsJson(source);

	const harborArgs = cfg.resume
		? buildResumeArgs(cfg, jobDir)
		: buildHarborArgs({
				dataset: cfg.dataset,
				jobsDir: cfg.jobsDir,
				jobName,
				concurrency: cfg.concurrency,
				attempts: cfg.attempts,
				tasks: cfg.tasks,
				models: cfg.models,
				include: cfg.include,
				exclude: cfg.exclude,
				allowHosts: cfg.allowHosts,
				timeoutMultiplier: cfg.timeoutMultiplier,
				yes: cfg.yes,
				composeOverlayPath,
				envType: cfg.envType,
				mountsJson,
				agent: cfg.agent,
				passthrough: cfg.passthrough,
			});
	const harborEnv = buildHarborEnv(cfg, modelsYaml, tarball, version, source);
	const logPath = path.join(benchDir, "harbor.log");
	if (cfg.dryRun) {
		process.stdout.write(`${bold("\nharbor command:\n")}harbor ${harborArgs.join(" ")}\n\n`);
		if (modelsYaml) {
			process.stdout.write(`${bold("models.yml:\n")}${fs.readFileSync(modelsYaml, "utf8")}\n`);
		}
		process.stdout.write(bold("veyyon env:\n"));
		for (const key in harborEnv) {
			if (key === "VEYYON_BENCH_FORWARD_ENV") continue;
			if (key.startsWith("VEYYON_BENCH_") || key === "PYTHONPATH") {
				process.stdout.write(`  ${key}=${harborEnv[key]}\n`);
			}
		}
		if (harborEnv.VEYYON_BENCH_FORWARD_ENV) {
			const parsedForwardEnv: unknown = JSON.parse(harborEnv.VEYYON_BENCH_FORWARD_ENV);
			if (isRecord(parsedForwardEnv)) {
				const keys = Object.keys(parsedForwardEnv);
				process.stdout.write(`  VEYYON_BENCH_FORWARD_ENV=${keys.join(",")} (values hidden)\n`);
			}
		}
		process.stdout.write(`\njob dir: ${jobDir}\nbench dir: ${benchDir}\n`);
		return { exitCode: 0, jobName, jobDir, benchDir, tarball, elapsedMs: 0, totals: null, reportPath: null };
	}

	if ((cfg.cleanup || cfg.cleanupForce) && cfg.envType === "docker" && which("docker")) {
		runDockerCleanup(cfg.cleanupForce);
	}

	const gatewayForward = startVmnetGatewayForward(cfg);
	process.stdout.write(dim(`launching harbor → ${logPath}\n`));
	const logFd = fs.openSync(logPath, "a");
	const proc = Bun.spawn(["harbor", ...harborArgs], {
		env: harborEnv,
		stdout: logFd,
		stderr: logFd,
		stdin: "ignore",
	});

	const expected = cfg.resume
		? (readJobResult(jobDir)?.nTotal ?? Math.max(1, cfg.tasks * cfg.attempts * cfg.models.length))
		: Math.max(1, cfg.tasks * cfg.attempts * cfg.models.length);
	const st: RenderState = { cfg, jobDir, logPath, startMs: Date.now(), expected, tick: 0 };

	if (isTTY) process.stdout.write(`${CSI}?1049h${CSI}?25l`);
	let exitCode = 0;
	let finished = false;
	proc.exited.then((code: number) => {
		exitCode = code;
		finished = true;
	});

	const onSig = (): void => {
		try {
			proc.kill("SIGINT");
		} catch {
			/* ignore */
		}
	};
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);

	try {
		while (!finished) {
			render(st);
			st.tick++;
			await Bun.sleep(isTTY ? 700 : 10000);
		}
		render(st);
	} finally {
		gatewayForward?.stop();
		if (isTTY) process.stdout.write(`${CSI}?25h${CSI}?1049l`);
		try {
			fs.closeSync(logFd);
		} catch {
			/* ignore */
		}
		process.off("SIGINT", onSig);
		process.off("SIGTERM", onSig);
	}

	const trials = readTrials(jobDir, cfg.agent);
	const totals = aggregate(trials, readJobResult(jobDir), expected);
	const successPct = totals.done > 0 ? (totals.pass / totals.done) * 100 : 0;
	const elapsedMs = Date.now() - st.startMs;
	const reportPath = writeReport(st, benchDir, exitCode);
	process.stdout.write(
		`\n${bold(`${st.cfg.dataset} complete`)} — ${green(`${totals.pass}/${totals.done} passed (${successPct.toFixed(1)}%)`)}\n` +
			`fail ${totals.fail} · error ${totals.error} · spend ${fmtUsd(totals.costUsd)} · elapsed ${fmtDur(elapsedMs)}\n` +
			`tokens: in ${fmtNum(totals.tokIn)} · out ${fmtNum(totals.tokOut)} · cache ${fmtNum(totals.tokCache)}\n` +
			`${dim("report:")} ${reportPath}\n${dim("logs:  ")} ${logPath}\n${dim("trials:")} ${jobDir}\n`,
	);
	if (exitCode !== 0) process.stdout.write(yellow(`harbor exited ${exitCode}; see harbor.log\n`));
	return { exitCode, jobName, jobDir, benchDir, tarball, elapsedMs, totals, reportPath };
}

export function mapErrorToExitCode(err: unknown): number {
	if (err instanceof HelpRequestedError) return 0;
	if (err instanceof HarborExecutionError) return err.exitCode;
	if (err instanceof GatewayHealthError) return 3;
	if (err instanceof HarborPrerequisiteError) return 2;
	return 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	try {
		if (argv[0] === "cleanup") {
			if (!which("docker")) throw new HarborPrerequisiteError("docker not found on PATH (required for cleanup).");
			runDockerCleanup(true);
			return 0;
		}
		let cfg = parseArgs(argv);
		if (cfg.resume) cfg = resolveResumeConfig(cfg);
		const res = await runBenchmark(cfg);
		return res.exitCode;
	} catch (err: unknown) {
		if (err instanceof HelpRequestedError) {
			process.stdout.write(HELP);
			return 0;
		}
		if (isTTY) process.stdout.write(`${CSI}?25h${CSI}?1049l`);
		process.stderr.write(red(`\nerror: ${errorMessage(err)}\n`));
		return mapErrorToExitCode(err);
	}
}

if (import.meta.main) {
	main().then(code => {
		process.exit(code);
	});
}

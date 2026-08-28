#!/usr/bin/env bun
import * as path from "node:path";

import { DEFAULT_JOBS_DIR, REPO_ROOT } from "./paths";

export const PKG_DIR = path.resolve(import.meta.dir, "..");
export const AGENT_DIR = path.join(PKG_DIR, "agent");
export const CODING_AGENT_DIR = path.join(REPO_ROOT, "packages", "coding-agent");
export const AGENT_IMPORT_PATH = "veyyon_local:VeyyonLocal";

export const SOURCE_SRC_MOUNT = "/opt/veyyon/src";
export const SOURCE_BIN_MOUNT = "/opt/veyyon/bin";

export const VMNET_HOST_IP = "192.168.64.1";
export const DOCKER_GATEWAY_URL = "http://host.docker.internal:4000";
export const VMNET_GATEWAY_URL = `http://${VMNET_HOST_IP}:4000`;
export const CONTAINER_DNS = process.env.VEYYON_BENCH_CONTAINER_DNS || "1.1.1.1";

export interface Config {
	models: string[];
	dataset: string;
	tasks: number;
	concurrency: number;
	attempts: number;
	include: string[];
	exclude: string[];
	thinking: string | null;
	agentArgs: string[];

	agent: string;
	install: "source" | "local" | "published";
	version: string | null;
	tarball: string | null;
	binaryArm64: string | null;
	binaryX64: string | null;
	build: boolean;
	jobsDir: string;
	jobName: string | null;
	gatewayUrl: string;
	gatewayToken: string;
	providers: string[];
	gateway: boolean;
	webSearch: boolean;
	allowHosts: string[];
	timeoutMultiplier: number | null;
	yes: boolean;
	dryRun: boolean;
	cleanup: boolean;
	cleanupForce: boolean;
	hostNetwork: boolean;
	resume: string | null;
	filterErrorTypes: string[];
	envType: "docker" | "apple-container";
	passthrough: string[];
	env: Record<string, string>;
}

export function defaultConfig(): Config {
	return {
		models: [],
		dataset: "terminal-bench@2.0",
		tasks: 20,
		concurrency: 4,
		attempts: 1,
		include: [],
		exclude: [],
		thinking: null,
		agentArgs: [],

		agent: "veyyon",
		install: "source",
		version: null,
		tarball: null,
		binaryArm64: null,
		binaryX64: null,
		build: true,
		jobsDir: DEFAULT_JOBS_DIR,
		jobName: null,
		gatewayUrl: DOCKER_GATEWAY_URL,
		gatewayToken: "no-auth",
		providers: [],
		gateway: true,
		webSearch: false,
		allowHosts: [],
		timeoutMultiplier: null,
		yes: true,
		dryRun: false,
		cleanup: false,
		cleanupForce: false,
		hostNetwork: false,
		resume: null,
		filterErrorTypes: [],
		envType: "docker",
		passthrough: [],
		env: {},
	};
}

export const HELP = `metaharness runner (local veyyon)

Usage: metaharness harbor [options] [-- <extra harbor args>]

Commands:
  cleanup                        Force-remove ALL leftover Harbor containers + networks, then exit

Model / agent:
  -m, --model <provider/model>   Model (repeatable). Default anthropic/claude-sonnet-4-6
      --agent <name>             veyyon (default) | oracle | nop | any harbor agent
      --install <source|local|published> veyyon install mode (default: source).
                                 source = mount /work/veyyon read-only + prebuilt linux deps tree; TS changes
                                 apply per-trial with no rebuild. local = pack a tarball. published = npm.
      --version <v>              veyyon version for published install (default: latest)
      --thinking <level>         off|minimal|low|medium|high|xhigh|max

      --tarball <path>           Reuse a prebuilt veyyon tarball (implies --install local, --no-build)
      --no-build                 Skip packing; reuse newest tarball in bench dir (--install local)
      --agent-arg <arg>          Extra arg forwarded verbatim to the in-container veyyon CLI (repeatable)
      --env <KEY[=VALUE]>        Forward env into veyyon container (repeatable).
                                 KEY alone forwards host value; host PI_* auto-forwarded.

Dataset / scale:
  -l, --tasks <N>                Max tasks (default 20)
  -n, --concurrency <N>          Concurrent trials (default 4)
  -k, --attempts <N>             Attempts per task (default 1)
  -i, --include <glob>           Include task name (repeatable)
  -x, --exclude <glob>           Exclude task name (repeatable)
  -d, --dataset <name@ver>       Default terminal-bench@2.0

Gateway (auth, no keys in container):
      --gateway-url <url>        Default http://host.docker.internal:4000
      --gateway-token <tok>      Default "no-auth" (gateway runs --no-auth)
      --providers <csv>          Providers to route (default: model provider + anthropic,openai-codex)
      --no-gateway               Pass host provider API keys into containers instead
      --web-search               Enable veyyon web_search (off by default; can't auth via gateway)
      --allow-host <host>        harbor --allow-agent-host (repeatable)

Environment:
      --environment <type>       docker (default) | apple-container (Apple 'container' CLI;
                                 no Docker needed, gateway auto-forwarded via 192.168.64.1)

Output / control:
  -o, --jobs-dir <path>          Default <repo>/runs/harbor
      --job-name <name>          Default <model>-<timestamp>
      --resume <name|path>       Resume that job dir: the original launch flags are recovered
                                 automatically (runner-config.json / manager.json), completed
                                 trials are kept and paid for once, the rest re-run
      --filter-error-type <T>    With --resume: also re-run completed trials whose exception
                                 type is <T> (repeatable; CancelledError is always evicted)
      --dry-run                  Print the harbor command + models.yml and exit
      --cleanup                  Clean up stale and exited Harbor Docker resources safely before starting (docker only)
      --cleanup-force            Force-stop and remove ALL previous Harbor Docker containers and networks (docker only)
      --host-network             Run Docker task containers using host networking (experimental)
  -h, --help                     This help
`;

export function parseArgs(argv: string[]): Config {
	const cfg = defaultConfig();
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (arg === "--") {
			const ps = argv.slice(i + 1);
			for (let pi = 0; pi < ps.length; pi++) cfg.passthrough.push(ps[pi]!);
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
			if (v === undefined) throw new Error(`missing value for ${flag}`);
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
					throw new Error("--install must be source|local|published");
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
				else throw new Error(`--binary: cannot infer arch from ${base} (expect arm64/x64 in filename)`);
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
				process.stdout.write(HELP);
				process.exit(0);
				break;
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
					throw new Error("--environment must be docker|apple-container");
				}
				cfg.envType = v;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg} (see --help)`);
		}
	}
	if (cfg.models.length === 0) cfg.models = ["anthropic/claude-sonnet-4-6"];
	if (cfg.envType === "apple-container") {
		if (cfg.hostNetwork) throw new Error("--host-network is docker-only (compose overlay)");
		if (cfg.gatewayUrl === DOCKER_GATEWAY_URL) cfg.gatewayUrl = VMNET_GATEWAY_URL;
	}
	return cfg;
}

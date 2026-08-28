/**
 * Harbor runner configuration schema, defaults, environment resolution, and
 * container execution environment construction.
 */
import type { HarnessBackendBinding, HarnessLookup } from "../../engine/contracts";
import { harborAgentDir, harborJobsDir } from "../../engine/package-paths";
import type { SourceMount } from "./deps";
import { deriveProviders } from "./gateway";

/** Container-side mount points for `--install source` (must match veyyon_local.py defaults). */
export const SOURCE_SRC_MOUNT = "/opt/veyyon/src";
export const SOURCE_BIN_MOUNT = "/opt/veyyon/bin";

/** Host address containers see on Apple Container's vmnet (bridge) network. */
export const VMNET_HOST_IP = "192.168.64.1";
export const DOCKER_GATEWAY_URL = "http://host.docker.internal:4000";
export const VMNET_GATEWAY_URL = `http://${VMNET_HOST_IP}:4000`;

/**
 * Resolver injected into Apple Container runs (VEYYON_BENCH_CONTAINER_DNS overrides).
 * The vmnet gateway resolver (192.168.64.1:53) is unreachable when VPN/DNS
 * agents on the host intercept port 53, so containers get an explicit one.
 */
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
	/** Extra args forwarded verbatim to the in-container veyyon CLI invocation (repeatable). */
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
	/** Job name (or job dir path) to resume via `harbor job resume` instead of starting a new run. */
	resume: string | null;
	/** With resume: evict+re-run completed trials that errored with these exception types. */
	filterErrorTypes: string[];
	/** Harbor environment backend running the task containers. */
	envType: "docker" | "apple-container";
	passthrough: string[];
	env: Record<string, string>;
	/** Extra volume mounts (compose format "host:container:ro") added to the overlay. */
	extraVolumes: string[];
}

export const DEFAULT_HARBOR_DATASET = "terminal-bench@2.0";

export function defaultConfig(options?: { defaultDataset?: string }): Config {
	return {
		models: [],
		dataset: options?.defaultDataset ?? DEFAULT_HARBOR_DATASET,
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
		jobsDir: harborJobsDir(),
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
		extraVolumes: [],
	};
}

/**
 * `harbor job resume` argv for an existing job dir: trial dirs with a
 * result.json are kept (their spend is reused), the rest re-run. Explicit
 * `-f` values REPLACE harbor's CancelledError default, so it is always
 * re-added alongside the caller's filters.
 */
export function buildResumeArgs(cfg: Config, jobDir: string): string[] {
	const a: string[] = ["job", "resume", "-p", jobDir];
	if (cfg.filterErrorTypes.length > 0) {
		for (const t of new Set(["CancelledError", ...cfg.filterErrorTypes])) a.push("-f", t);
	}
	a.push(...cfg.passthrough);
	return a;
}

export const FORWARD_ENV_DENYLIST = new Set([
	"VEYYON_CODING_AGENT_DIR",
	"VEYYON_CONFIG_DIR",
	"VEYYON_PROFILE",
	"VEYYON_PACKAGE_DIR",
	"VEYYON_SESSION_FILE",
	"VEYYON_ARTIFACTS_DIR",
	"VEYYON_TOOL_BRIDGE_URL",
	"VEYYON_TOOL_BRIDGE_TOKEN",
	"VEYYON_TOOL_BRIDGE_SESSION",
	"VEYYON_EVAL_LOCAL_ROOTS",
	"VEYYON_AUTH_BROKER_URL",
	"VEYYON_AUTH_BROKER_TOKEN",
]);

/**
 * Env vars injected into the in-container veyyon run: every host `VEYYON_*` knob (minus
 * container-hostile dir/profile/session keys) plus explicit `--env` entries,
 * which always win and bypass the denylist.
 */
export function collectForwardEnv(cfg: Config): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || !k.startsWith("VEYYON_") || FORWARD_ENV_DENYLIST.has(k)) continue;
		out[k] = v;
	}
	for (const [k, v] of Object.entries(cfg.env)) out[k] = v;
	return out;
}

/**
 * The binding is resolved by the caller, which has the roster. Passing the roster
 * here instead would make an absent roster look like an unbound agent, and an
 * unbound agent gets a bare environment: the two states print the same container
 * and only one of them is correct.
 */
export function buildHarborEnv(
	cfg: Config,
	modelsYaml: string,
	tarball: string | null,
	version: string,
	source: SourceMount | null = null,
	binding?: HarnessBackendBinding | null,
): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	// Drop any stale VEYYON_BENCH_FORWARD_ENV inherited from the caller's shell before
	// the agent-type early return, so it never leaks (incl. into the dry-run dump).
	delete env.VEYYON_BENCH_FORWARD_ENV;
	// The auth broker runs on the host's loopback. Containers cannot reach it
	// and must route through the gateway instead, so leaking the broker URL
	// and token makes the in-container veyvon try 127.0.0.1:8765 and fail.
	delete env.VEYYON_AUTH_BROKER_URL;
	delete env.VEYYON_AUTH_BROKER_TOKEN;
	if (!binding) return env;
	const prepend = (k: string, v: string): void => {
		env[k] = env[k] ? `${v}:${env[k]}` : v;
	};
	prepend("PYTHONPATH", harborAgentDir());
	env.VEYYON_BENCH_INSTALL = cfg.install;
	env.VEYYON_BENCH_VERSION = cfg.version ?? version;
	if (tarball) env.VEYYON_BENCH_TARBALL = tarball;
	if (source) {
		env.VEYYON_BENCH_SOURCE_DIR = SOURCE_SRC_MOUNT;
		env.VEYYON_BENCH_SOURCE_BUN = `${SOURCE_BIN_MOUNT}/bun`;
		env.VEYYON_BENCH_SOURCE_ARCH = source.arch;
	}
	if (cfg.binaryArm64) env.VEYYON_BENCH_BINARY_ARM64 = cfg.binaryArm64;
	if (cfg.binaryX64) env.VEYYON_BENCH_BINARY_X64 = cfg.binaryX64;
	if (cfg.thinking) env.VEYYON_BENCH_THINKING = cfg.thinking;
	if (cfg.agentArgs.length > 0) env.VEYYON_BENCH_AGENT_ARGS = JSON.stringify(cfg.agentArgs);
	if (cfg.webSearch) env.VEYYON_BENCH_WEB_SEARCH = "1";
	// The gateway is a property of the binding: a harness whose credentials travel in its
	// own program env file never announces a gateway it will not use, on either path.
	const gateway = cfg.gateway && binding.authGateway === true;
	env.VEYYON_BENCH_GATEWAY = gateway ? "1" : "0";
	if (gateway) {
		env.VEYYON_BENCH_MODELS_YAML = modelsYaml;
		env.VEYYON_BENCH_GATEWAY_URL = cfg.gatewayUrl;
		env.VEYYON_BENCH_GATEWAY_TOKEN = cfg.gatewayToken;
		env.VEYYON_BENCH_GATEWAY_PROVIDERS = deriveProviders(cfg).join(",");
	}
	if (cfg.envType === "apple-container") env.VEYYON_BENCH_CONTAINER_DNS = CONTAINER_DNS;
	const forward = collectForwardEnv(cfg);
	if (Object.keys(forward).length > 0) env.VEYYON_BENCH_FORWARD_ENV = JSON.stringify(forward);
	if (binding.envVars) {
		Object.assign(env, binding.envVars);
	}
	return env;
}

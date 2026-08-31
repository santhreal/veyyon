/**
 * A model served by the host that launched the run, rather than by a vendor over the
 * internet.
 *
 * A trial container reaches it under the same egress policy every other inference
 * endpoint answers under, and that policy decides both halves of the address:
 *
 * 1. The address is the host's docker bridge, not the loopback address the host itself
 *    uses. Every bridge network on a host routes to `172.17.0.1`, so one address covers
 *    the default bridge and every per-trial compose network.
 * 2. The port is 80. The egress proxy both container frameworks run allows ports 80 and
 *    443 and refuses every other, so a model server on 1234 is unreachable from a trial
 *    however the allowlist is spelled. `scripts/local-endpoint-bridge.sh` publishes the
 *    bridge address on port 80 and forwards to the server's own port.
 *
 * The destination is then allowlisted like any vendor host, by the literal bridge
 * address, which the proxy matches as a destination name. An empty allowlist is not the
 * alternative it looks like: a task that declares no network gets `network_mode: none`,
 * where nothing is reachable at all.
 *
 * The variable each provider reads for its base URL is the same one the agent binary
 * reads on a developer's machine, so a run inherits an endpoint the host already names
 * and rewrites only the address and port the container cannot use.
 */

import { errorMessage } from "@veyyon/utils";
import { parseModelId } from "./trial-model";

/** The host address a container reaches through the docker bridge. */
export const CONTAINER_HOST_ADDRESS = "172.17.0.1";

/**
 * The port a trial's egress proxy permits. Squid's `Safe_ports` list is 80 and 443, and a
 * request to any other port is denied before the destination is even matched.
 */
export const CONTAINER_ENDPOINT_PORT = 80;

/** The command that publishes the bridge address on the permitted port. */
export const LOCAL_ENDPOINT_BRIDGE_COMMAND = "bash packages/evals/scripts/local-endpoint-bridge.sh up";

/** Loopback spellings a host uses for an endpoint a container cannot reach. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"];

interface LocalProvider {
	/** The environment variable the harness binary reads for this provider's base URL. */
	readonly baseUrlVar: string;
	/** The endpoint the provider serves on when the host names none. */
	readonly defaultBaseUrl: string;
}

/**
 * Providers whose endpoint is a process on this host. Keyed by the provider segment of a
 * model selector, and the base URL variables match the ones the coding agent reads
 * (`packages/coding-agent/src/config/model-registry.ts`).
 */
const LOCAL_PROVIDERS: Readonly<Record<string, LocalProvider>> = {
	"lm-studio": { baseUrlVar: "LM_STUDIO_BASE_URL", defaultBaseUrl: "http://127.0.0.1:1234/v1" },
	"llama.cpp": { baseUrlVar: "LLAMA_CPP_BASE_URL", defaultBaseUrl: "http://127.0.0.1:8080/v1" },
	ollama: { baseUrlVar: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434" },
	vllm: { baseUrlVar: "VLLM_BASE_URL", defaultBaseUrl: "http://127.0.0.1:8000/v1" },
};

/** Whether the model selector names a provider served by this host. */
export function isLocalInferenceModel(model: string): boolean {
	return parseModelId(model).provider in LOCAL_PROVIDERS;
}

/**
 * The endpoint a container reads: the bridge address on the permitted port, keeping the
 * path the host named, which is where the provider's OpenAI-compatible routes live.
 */
function containerVisibleUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (!LOOPBACK_HOSTS.includes(parsed.hostname.toLowerCase())) return parsed.toString().replace(/\/$/, "");
		parsed.hostname = CONTAINER_HOST_ADDRESS;
		parsed.port = String(CONTAINER_ENDPOINT_PORT);
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return url;
	}
}

/** The providers this host can serve, so a caller sweeps the table rather than restating it. */
export function localInferenceProviders(): readonly string[] {
	return Object.keys(LOCAL_PROVIDERS).sort();
}

/**
 * The destinations a container running a local model may reach: the host the endpoint
 * answers on and nothing else. The proxy matches a literal address as a destination name,
 * so the trial keeps the task's network policy for everything except the model.
 */
export function localEndpointAllowedDomains(
	model: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
	const endpoint = containerLocalEndpointEnv(model, env);
	if (!endpoint) return [];
	const [baseUrl] = Object.values(endpoint);
	return [new URL(baseUrl as string).hostname];
}

/**
 * The environment a container needs to reach a locally served model, or null when the
 * model is served by a vendor. `env` is the host environment the run was launched from,
 * which names the endpoint when it is not the provider's default.
 */
export function containerLocalEndpointEnv(
	model: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> | null {
	const provider = LOCAL_PROVIDERS[parseModelId(model).provider];
	if (!provider) return null;
	const hostUrl = env[provider.baseUrlVar] ?? provider.defaultBaseUrl;
	return { [provider.baseUrlVar]: containerVisibleUrl(hostUrl) };
}

/**
 * The refusal a run earns when a locally served model is not reachable at the address the
 * container will read, or null when it is. A vendor model is reachable by definition here,
 * so it earns no refusal.
 *
 * Probed from the host, which reaches the bridge address the same way a container does, so
 * a missing forwarder is a preflight refusal naming the command rather than a trial that
 * spends its deadline listing an empty model catalog.
 */
export async function localEndpointRefusal(
	model: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
	const endpoint = containerLocalEndpointEnv(model, env);
	if (!endpoint) return null;
	const [baseUrl] = Object.values(endpoint);
	const url = new URL(baseUrl as string);
	const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
	if (port !== 80 && port !== 443) {
		return `local model endpoint at ${url.href} answers on port ${port}, which a trial's egress proxy refuses; publish it on port ${CONTAINER_ENDPOINT_PORT} with: ${LOCAL_ENDPOINT_BRIDGE_COMMAND}`;
	}
	const probe = `${url.href.replace(/\/$/, "")}/models`;
	try {
		const response = await fetch(probe, { signal: AbortSignal.timeout(5000) });
		if (response.ok) return null;
		return `local model endpoint at ${probe} answered ${response.status}`;
	} catch (error) {
		return `local model endpoint at ${probe} is unreachable (${errorMessage(error)}); publish it with: ${LOCAL_ENDPOINT_BRIDGE_COMMAND}`;
	}
}

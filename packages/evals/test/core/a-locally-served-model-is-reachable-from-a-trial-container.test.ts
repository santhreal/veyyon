/**
 * WHY THIS SUITE EXISTS. A run against a model served by the host measured nothing: the
 * trial container exported `LM_STUDIO_BASE_URL=http://172.17.0.1:1234/v1`, declared no
 * allowed destinations, and pier gave the task container `network_mode: none`, where
 * nothing is reachable at all. The catalog refresh returned `{"models":[]}` and every
 * trial in the run died the same way in under two seconds.
 *
 * THE CLASS: a locally served endpoint has to satisfy three facts at once, and getting two
 * of them right still measures nothing.
 *
 *   1. The address a container reads is the host's docker bridge, never a loopback host.
 *   2. The port is one the egress proxy permits (80 or 443); every other port is refused
 *      before the destination is matched.
 *   3. The destination is declared to the egress policy, so the proxy is built and allows
 *      exactly it. Declaring nothing is not "no proxy": it is no network.
 *
 * Every case sweeps `localInferenceProviders()` and the registered harness roster at run
 * time, so a provider or harness added later is covered the moment it is declared, and a
 * harness that reaches a local model without declaring the destination fails here.
 *
 * WHAT IT DOES NOT CATCH: whether the host is actually running a model server, and whether
 * the bridge forwarder is up. Those are live-state facts, so the harness preflight probes
 * them and refuses with the command that fixes it; the probe itself is exercised below with
 * an endpoint nothing serves.
 */

import { describe, expect, it } from "bun:test";
import { harnesses } from "../../engine/loaded-members";
import {
	CONTAINER_ENDPOINT_PORT,
	CONTAINER_HOST_ADDRESS,
	containerLocalEndpointEnv,
	isLocalInferenceModel,
	localEndpointAllowedDomains,
	localEndpointRefusal,
	localInferenceProviders,
} from "../../engine/local-inference-endpoint";

const providers = localInferenceProviders();
/** One row per provider, so each sweep names the provider it failed on. */
const providerCases: [string][] = providers.map(provider => [provider]);
const modelOf = (provider: string): string => `${provider}/some-local-model`;
/** The endpoint of every local provider, read with a host environment that names none. */
const endpointOf = (provider: string): string => {
	const endpoint = containerLocalEndpointEnv(modelOf(provider), {});
	expect(endpoint).not.toBeNull();
	const [baseUrl] = Object.values(endpoint as Record<string, string>);
	return baseUrl as string;
};

describe("the address a container reads", () => {
	it("has local providers to sweep", () => {
		expect(providers.length).toBeGreaterThan(0);
	});

	it.each(providerCases)("%s is recognized as served by this host", provider => {
		expect(isLocalInferenceModel(modelOf(provider))).toBe(true);
	});

	it.each(providerCases)("%s answers on the bridge address, never a loopback host", provider => {
		expect(new URL(endpointOf(provider)).hostname).toBe(CONTAINER_HOST_ADDRESS);
	});

	it.each(providerCases)("%s answers on a port the egress proxy permits", provider => {
		const url = new URL(endpointOf(provider));
		const port = url.port === "" ? 80 : Number(url.port);
		expect(port).toBe(CONTAINER_ENDPOINT_PORT);
	});

	it.each(providerCases)("%s keeps the path the provider serves its routes on", provider => {
		const provided = containerLocalEndpointEnv(modelOf(provider), {});
		const [baseUrl] = Object.values(provided as Record<string, string>);
		// A default with no path stays pathless; one with /v1 keeps it. Rewriting the host
		// and port must not move the routes.
		expect(new URL(baseUrl as string).pathname).toMatch(/^\/(v1)?$/);
	});

	it("rewrites the port of a host-named endpoint, whatever port the server chose", () => {
		const endpoint = containerLocalEndpointEnv("lm-studio/m", { LM_STUDIO_BASE_URL: "http://127.0.0.1:9999/v1" });
		expect(endpoint).toEqual({ LM_STUDIO_BASE_URL: `http://${CONTAINER_HOST_ADDRESS}/v1` });
	});

	it("leaves an endpoint on another machine alone, which is reachable as it stands", () => {
		const endpoint = containerLocalEndpointEnv("lm-studio/m", { LM_STUDIO_BASE_URL: "http://gpu-box.lan/v1" });
		expect(endpoint).toEqual({ LM_STUDIO_BASE_URL: "http://gpu-box.lan/v1" });
	});

	it("states nothing for a vendor model, which needs no rewrite", () => {
		expect(containerLocalEndpointEnv("anthropic/claude-sonnet-5", {})).toBeNull();
		expect(isLocalInferenceModel("anthropic/claude-sonnet-5")).toBe(false);
	});
});

describe("the destination the egress policy is told about", () => {
	it.each(providerCases)("%s declares the host its endpoint answers on", provider => {
		expect(localEndpointAllowedDomains(modelOf(provider), {})).toEqual([CONTAINER_HOST_ADDRESS]);
	});

	it("declares the remote host when the endpoint is on another machine", () => {
		expect(localEndpointAllowedDomains("lm-studio/m", { LM_STUDIO_BASE_URL: "http://gpu-box.lan/v1" })).toEqual([
			"gpu-box.lan",
		]);
	});

	it("declares nothing for a vendor model, whose own domain list applies", () => {
		expect(localEndpointAllowedDomains("anthropic/claude-sonnet-5", {})).toEqual([]);
	});

	/**
	 * A harness that delivers itself through a container program states its destinations in
	 * that program. Sweeping the roster means a harness added later fails here until it
	 * decides what a local model may reach, rather than shipping a program whose empty
	 * domain list silently means no network.
	 */
	const programHarnesses = harnesses.list().filter(harness => harness.containerProgram !== undefined);

	it("has program harnesses to sweep", () => {
		expect(programHarnesses.length).toBeGreaterThan(0);
	});

	it.each(programHarnesses.map(harness => harness.id))("%s allows exactly the endpoint host", name => {
		const harness = programHarnesses.find(entry => entry.id === name);
		const staged = harness?.containerProgram?.({
			model: "lm-studio/some-local-model",
			options: {},
		});
		expect(staged?.program.allowedDomains).toEqual([CONTAINER_HOST_ADDRESS]);
	});

	it.each(programHarnesses.map(harness => harness.id))("%s keeps its vendor domains otherwise", name => {
		const harness = programHarnesses.find(entry => entry.id === name);
		const staged = harness?.containerProgram?.({
			model: "anthropic/claude-sonnet-5",
			options: {},
		});
		expect((staged?.program.allowedDomains ?? []).length).toBeGreaterThan(0);
		expect(staged?.program.allowedDomains).not.toContain(CONTAINER_HOST_ADDRESS);
	});
});

describe("a preflight refusal instead of a run that measures nothing", () => {
	it("refuses an endpoint on a port the proxy denies, naming the port and the fix", async () => {
		const refusal = await localEndpointRefusal("lm-studio/m", { LM_STUDIO_BASE_URL: "http://gpu-box.lan:1234/v1" });

		expect(refusal).toContain("port 1234");
		expect(refusal).toContain("local-endpoint-bridge.sh");
	});

	it("refuses an endpoint nothing answers on, naming the address it probed", async () => {
		// Port 80 of an address in the reserved TEST-NET-1 range: a permitted port, so the
		// refusal comes from the probe rather than the port rule, and nothing routes there.
		const refusal = await localEndpointRefusal("lm-studio/m", { LM_STUDIO_BASE_URL: "http://192.0.2.1/v1" });

		expect(refusal).toContain("192.0.2.1");
		expect(refusal).toContain("unreachable");
	});

	it("earns no refusal for a vendor model, whose credential preflight owns that verdict", async () => {
		expect(await localEndpointRefusal("anthropic/claude-sonnet-5", {})).toBeNull();
	});
});

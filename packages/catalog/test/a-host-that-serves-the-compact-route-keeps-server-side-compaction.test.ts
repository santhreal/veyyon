import { describe, expect, test } from "bun:test";
import { buildOpenAIResponsesCompat } from "@veyyon/catalog/compat/openai";
import { KNOWN_HOSTS } from "@veyyon/catalog/hosts";

/**
 * WHY: server-side compaction has been switched off and back on for the
 * ChatGPT Codex backend more than once, each time by editing one boolean
 * expression in `buildOpenAIResponsesCompat`. Nothing failed when it was
 * removed, because the surrounding tests each pinned one host by hand and a
 * deleted disjunct simply stopped being covered.
 *
 * The class this closes: a host silently gaining or losing
 * `supportsServerCompaction`. The enabled set is derived here by sweeping
 * `KNOWN_HOSTS` at run time and compared by exact equality, so adding a host,
 * removing a host, or flipping one turns this red and forces the decision to
 * be written down.
 *
 * What it does NOT catch: whether the host actually serves the route. That is
 * a live-network fact, answered at run time by the 404 handling in
 * `openai-compaction.ts` and covered by its own suite.
 */

/** The declared shape of a `KNOWN_HOSTS` entry, which the table itself does not export. */
interface HostClassSpecLike {
	readonly providers?: readonly string[];
	readonly providerPrefixes?: readonly string[];
	readonly urlMarkers: readonly string[];
}

const HOST_SPECS = Object.entries(KNOWN_HOSTS) as Array<[string, HostClassSpecLike]>;

/** Host classes whose provider id declares the compact route is served. */
const HOSTS_THAT_SERVE_THE_COMPACT_ROUTE = ["azureOpenAI", "codexBackend", "openai"];

function hostsEnablingServerCompaction(): string[] {
	const enabled: string[] = [];
	for (const [hostClass, spec] of HOST_SPECS) {
		const anyProviderEnables = (spec.providers ?? []).some(
			provider => buildOpenAIResponsesCompat({ provider, name: "Model", baseUrl: "" }).supportsServerCompaction,
		);
		if (anyProviderEnables) enabled.push(hostClass);
	}
	return enabled.sort();
}

describe("server-side compaction capability across every known host", () => {
	test("exactly the hosts that serve the compact route enable it", () => {
		expect(hostsEnablingServerCompaction()).toEqual(HOSTS_THAT_SERVE_THE_COMPACT_ROUTE);
	});

	test("every host class in the sweep is reachable, so none is silently skipped", () => {
		const unreachable = HOST_SPECS.filter(
			([, spec]) => (spec.providers ?? []).length === 0 && (spec.providerPrefixes ?? []).length === 0,
		)
			.map(([hostClass]) => hostClass)
			.sort();
		// A URL-only host class carries no provider id, so the provider sweep
		// cannot construct it. Pinned by exact equality: a new one must be
		// given a marker-based case rather than dropping out of coverage.
		expect(unreachable).toEqual(["chutes", "fireworks"]);
	});

	test("a URL-only host class does not enable it through its marker either", () => {
		for (const hostClass of ["chutes", "fireworks"] as const) {
			for (const marker of KNOWN_HOSTS[hostClass].urlMarkers) {
				expect(
					buildOpenAIResponsesCompat({ provider: "openai", name: "Model", baseUrl: `https://api.${marker}/v1` })
						.supportsServerCompaction,
				).toBe(false);
			}
		}
	});

	test("the ChatGPT Codex backend enables it by provider id and by base URL", () => {
		for (const provider of KNOWN_HOSTS.codexBackend.providers) {
			expect(buildOpenAIResponsesCompat({ provider, name: "Model", baseUrl: "" }).supportsServerCompaction).toBe(
				true,
			);
		}
		// Host classification is marker OR provider id, so a row repointed at
		// the codex backend is the codex backend and keeps the route.
		for (const marker of KNOWN_HOSTS.codexBackend.urlMarkers) {
			expect(
				buildOpenAIResponsesCompat({ provider: "openai", name: "Model", baseUrl: `https://${marker}/codex` })
					.supportsServerCompaction,
			).toBe(true);
		}
	});
});

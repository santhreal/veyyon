/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `config/settings-domains/interaction.ts` imported
 * `DEFAULT_RELAY_URL` from `collab/protocol`, a constant `@veyyon/wire` owns and
 * `protocol` merely re-exports. Every process that read a setting therefore
 * evaluated the collab wire codec, and `slash-commands/builtin-registry.ts`
 * imported `CollabHost` and `CollabGuestLink` at the top level, so it also
 * evaluated the relay socket, the room crypto and the guest client — in a
 * session that never hosts and never joins. The same shape shipped the stats
 * dashboard into every startup.
 *
 * THE CLASS. Declaring a setting must not load the feature the setting
 * configures, and registering a slash command must not load the client the
 * command drives. A settings domain may reach the option tables it enumerates
 * (they are leaves: a list of model keys, a list of provider ids) and nothing
 * else.
 *
 * HOW IT FAILS BY DEFAULT. The domain files are enumerated from disk at run
 * time and the areas each one reaches are pinned by exact equality. A new domain
 * file, or a new edge out of an existing one, turns this red until someone
 * records the decision. A domain that stops reaching an area does too, because
 * a stale pin describes a graph that no longer exists.
 *
 * WHAT IT DOES NOT CATCH. It measures reach, not cost: a cheap edge and an
 * expensive one look the same here, and the sibling suite
 * `a-dependency-nobody-reached-does-not-load-at-startup.test.ts` is what keeps a
 * heavy third-party package out of startup. It also says nothing about a
 * feature loaded later in a session.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildStartupImportGraph, type StartupImportGraph } from "./helpers/startup-import-graph";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SRC = join(REPO_ROOT, "packages", "coding-agent", "src");
const DOMAINS_DIR = join(SRC, "config", "settings-domains");

/**
 * The areas a settings domain is allowed to reach, one row per domain file.
 *
 * `config/`, `utils/` and the workspace packages are settings machinery. The
 * feature directories that remain — `stt/`, `tiny/`, `tts/`, `web/`, `tools/` —
 * are reached for their option tables only; each of those modules is a leaf that
 * declares model keys, device names or provider ids and loads no client.
 */
const DOMAIN_REACH: Record<string, string[]> = {
	"appearance.ts": ["config/"],
	"context.ts": ["config/", "npm:@veyyon/agent-core", "npm:@veyyon/ai", "npm:argot", "npm:@veyyon/utils"],
	"editing.ts": ["config/", "npm:@veyyon/utils", "npm:yaml", "utils/"],
	"general.ts": ["config/"],
	"global.ts": ["config/", "npm:@veyyon/utils", "npm:yaml"],
	"interaction.ts": ["config/", "npm:@veyyon/wire", "speech/"],
	"model.ts": ["config/", "npm:@veyyon/agent-core", "npm:@veyyon/catalog", "thinking/"],
	"providers.ts": ["config/", "npm:@veyyon/utils", "npm:yaml", "speech/", "tiny/", "web/"],
	"resources.ts": ["config/"],
	"shared.ts": ["config/"],
	"subagents.ts": ["config/"],
	"tasks.ts": ["config/"],
	"tools.ts": ["config/", "tools/"],
};

/**
 * The directory (inside coding-agent) each reached file belongs to, plus the
 * packages the walk named. A file in another workspace package is covered by
 * its package name, so only coding-agent's own layout is mapped here.
 */
function areasOf(graph: StartupImportGraph): string[] {
	const areas = new Set<string>();
	for (const file of graph.files) {
		if (!file.startsWith(`${SRC}/`)) continue;
		const segments = file.slice(SRC.length + 1).split("/");
		areas.add(segments.length > 1 ? `${segments[0]}/` : "(src root)");
	}
	for (const name of graph.packages) areas.add(`npm:${name}`);
	return [...areas].sort();
}

const domainFiles = readdirSync(DOMAINS_DIR)
	.filter(name => name.endsWith(".ts"))
	.sort();

describe("a settings domain reaches option tables, never a feature client", () => {
	test("every domain file on disk has a recorded reach", () => {
		expect(domainFiles).toEqual(Object.keys(DOMAIN_REACH).sort());
	});

	for (const name of domainFiles) {
		test(`${name} reaches exactly what it is allowed to`, () => {
			const graph = buildStartupImportGraph(REPO_ROOT, join(DOMAINS_DIR, name));
			expect(graph.unscannable).toEqual([]);
			expect(areasOf(graph)).toEqual([...(DOMAIN_REACH[name] ?? [])].sort());
		});
	}
});

describe("registering a slash command does not load its client", () => {
	const registry = buildStartupImportGraph(REPO_ROOT, join(SRC, "slash-commands", "builtin-registry.ts"));

	test("the walk is complete", () => {
		expect(registry.unscannable).toEqual([]);
		expect(registry.files.size).toBeGreaterThan(100);
	});

	test("the collab host and guest clients stay out of the registry", () => {
		const clients = [
			join(SRC, "collab", "host.ts"),
			join(SRC, "collab", "guest.ts"),
			join(SRC, "collab", "relay-client.ts"),
		];
		expect(clients.filter(file => registry.files.has(file))).toEqual([]);
	});

	test("the stats dashboard stays out of the registry", () => {
		expect(registry.packages.has("@veyyon/stats")).toBe(false);
	});
});

/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `stream.ts` imported `streamGitLabDuoWorkflow` statically, so every process that
 * can stream a turn, which is every interactive session, parsed and compiled the 3,000-line GitLab Duo
 * Workflow protocol client whether or not a `gitlab-duo-agent` model was ever selected. The provider
 * routes on `model.api` alone and needs nothing from its module before streaming begins, so it belongs
 * behind `register-builtins.ts` with the other provider streams.
 *
 * THE CLASS. A provider module under `src/providers/` loads on the first turn that selects it, through
 * `register-builtins.ts`. The provider directory is read at run time and the subset `stream.ts` reaches
 * statically is pinned by exact equality: a provider imported eagerly, directly or through a module
 * that imports it, turns this red until it is recorded below.
 *
 * WHAT IT DOES NOT CATCH. The walk is static, so a provider loaded through `await import(...)` is outside
 * it by design. That the lazy wrapper streams a provider the same way the direct call did is the
 * provider suites' contract (`gitlab-duo-workflow-provider.test.ts`, the budget sweeps over every API).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModuleReachCache, moduleReach } from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dirname, "..", "src");
const PROVIDERS = path.join(SRC, "providers");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const reached = moduleReach(
	path.join(SRC, "stream.ts"),
	workspaceModuleReachResolution(REPO_ROOT),
	createModuleReachCache(),
);

describe("the streaming engine's static import graph", () => {
	it("reads a provider directory worth judging", () => {
		expect(fs.readdirSync(PROVIDERS).filter(name => name.endsWith(".ts")).length).toBeGreaterThan(30);
	});

	it("holds exactly the provider modules a turn needs before it knows which provider streams", () => {
		const eager = fs
			.readdirSync(PROVIDERS)
			.filter(name => name.endsWith(".ts") && reached.has(path.join(PROVIDERS, name)))
			.sort();
		expect(eager).toEqual([
			// Shared by every provider's error mapping.
			"error-message.ts",
			// `isGitLabDuoModel`, `isKimiModel` and `isSyntheticModel` route a turn synchronously, and
			// each module is a thin wrapper over a lazily loaded transport.
			"gitlab-duo.ts",
			// Vertex resolves Application Default Credentials before the lazy stream is called.
			"google-auth.ts",
			"kimi.ts",
			// The Anthropic-wire shim `kimi.ts` and `synthetic.ts` route through.
			"openai-anthropic-shim.ts",
			"pi-native-client.ts",
			// The lazy loader itself.
			"register-builtins.ts",
			"synthetic.ts",
		]);
	});
});

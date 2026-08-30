/**
 * WHY THIS EXISTS. A shipped module that no test names is a blind spot nothing reports. A
 * pre-release sweep found twelve of them among the 266 modules changed since v1.2.0, including the
 * Startpage bot-wall refusal and both newly added authentication registries: three paths that had
 * shipped, changed, and never been named by a test. A sweep finds that once. A gate keeps finding it.
 *
 * WHAT IT DOES. It enumerates every shipped TypeScript module under `<root>/<member>/src` at run time,
 * enumerates every test file at run time, and asserts that the set of modules no test names is
 * EXACTLY the list below. A module added without a test turns this red. The list is shrink-only:
 * deleting an entry because the module gained a test is the point, and adding one records a decision
 * that a shipped module ships unnamed rather than letting the silence pass.
 *
 * WHAT IT DOES NOT CATCH. "A test names it" is not "a test covers its behavior". A module can be
 * named by an import and have none of its branches exercised, and this gate calls that named. It is a
 * floor, not a coverage measurement. It is deliberately permissive in three ascending steps (exact
 * module key, bare path segment, raw substring), so a module reached only through a barrel or written
 * only as a basename still counts as named. It therefore under-reports and never over-reports, which
 * means a red here is a real new blind spot rather than a false alarm.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { typeScriptRootDirectories } from "./workspace-layout.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** This file lists unnamed modules by path, so counting itself would mark every one of them named. */
const SELF = path.join("scripts", "a-shipped-module-arrives-with-a-test-that-names-it.test.ts");

/**
 * Directory names the walk never enters: foreign trees, build output and the
 * untracked run artifacts a benchmark writes. Every name here is either not
 * checked in or holds no TypeScript, so a skip can never hide a test file.
 * `packages/evals/suites/deep-swe` and `packages/evals/test/suites/deep-swe` are
 * checked-in source and are walked.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "repo-cache", "runs", "assets"]);

function walk(dir: string, keep: (file: string) => boolean): string[] {
	const found: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			found.push(...walk(full, keep));
		} else if (keep(full)) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Every workspace member directory, across the roots the root manifest declares.
 *
 * This read `packages/` alone, so a shipped module under any other root — `contracts/view/src` is
 * one — was neither required to have a test naming it nor able to count as naming one. Both halves
 * of the rule went missing at once and the suite stayed green.
 */
function packageDirs(): string[] {
	const dirs: string[] = [];
	for (const root of typeScriptRootDirectories()) {
		const directory = path.join(REPO_ROOT, root);
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			dirs.push(path.join(directory, entry.name));
		}
	}
	return dirs;
}

/** Every shipped module: under `src`, TypeScript, not a declaration file and not a test. */
function collectShippedModules(): string[] {
	const files: string[] = [];
	for (const pkg of packageDirs()) {
		files.push(
			...walk(
				path.join(pkg, "src"),
				file => file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.includes(".test."),
			),
		);
	}
	return files.map(file => path.relative(REPO_ROOT, file)).sort();
}

/**
 * Every test file, which is what may name a module.
 *
 * Walked over the WHOLE package rather than its `test/` directory. While the walk
 * was `<pkg>/test`, a suite sitting beside the module it tests counted for nothing,
 * and `packages/simulations` places its suites exactly there, so `harness.ts` read
 * as unnamed while the scenario suite naming it sat next to it. `shippedModules`
 * already excludes `.test.` files, so widening this cannot make a test file look
 * like a shipped module.
 */
function collectTestFiles(): string[] {
	const files: string[] = [];
	for (const pkg of packageDirs()) {
		files.push(...walk(pkg, file => file.endsWith(".test.ts") || file.endsWith(".test.tsx")));
		files.push(...walk(path.join(pkg, "test"), file => file.endsWith(".ts")));
	}
	files.push(...walk(path.join(REPO_ROOT, "scripts"), file => file.endsWith(".test.ts")));
	return [...new Set(files.map(file => path.relative(REPO_ROOT, file)))].filter(file => file !== SELF);
}

let shippedModulesCache: string[] | undefined;
let testFilesCache: string[] | undefined;

/**
 * The module list, walked once.
 *
 * Three cells ask for it and one asks twice. The walk is deterministic, so a second answer was
 * never different, only slower: under the leak checker every test file in the repository runs at
 * once, and six full walks of every member's `src` and `test` took this suite past the per-test
 * deadline it clears comfortably on its own.
 */
function shippedModules(): string[] {
	shippedModulesCache ??= collectShippedModules();
	return shippedModulesCache;
}

/** The test-file list, walked once, for the reason stated on `shippedModules`. */
function testFiles(): string[] {
	testFilesCache ??= collectTestFiles();
	return testFilesCache;
}

const QUOTED_PATH = /['"`]([^'"`\n]*\/[^'"`\n]*)['"`]/g;

/**
 * A maximal run of the characters a module path is made of.
 *
 * Route 3 asks whether a suffix appears anywhere in the test corpus. Asked of the concatenated
 * corpus that is one scan of every test file's bytes per candidate, which is the cost that put this
 * suite over the leak checker's per-test deadline. Asked of the DISTINCT runs below it is the same
 * question: a needle made only of these characters is a contiguous run, so it lies inside one
 * maximal run or nowhere, and the runs are joined on a character the class excludes so no match can
 * straddle two of them. Same verdict, a corpus two orders of magnitude smaller.
 */
const PATH_TOKEN = /[A-Za-z0-9_./-]+/g;

/** A suffix the token index can answer for, which is every suffix drawn from `PATH_TOKEN`'s class. */
const PATH_CHARS_ONLY = /^[A-Za-z0-9_./-]+$/;

/** The `src`-relative path of a shipped module, which is the key every route compares against. */
const SRC_SUFFIX = /\/src\/(.+)\.ts$/;

/** Reduce a quoted specifier to the `src`-relative key a shipped module would carry. */
function moduleKey(literal: string): string {
	return literal
		.trim()
		.replace(/^@veyyon\/[^/]+\//, "")
		.replace(/^(?:\.\.\/)+/, "")
		.replace(/^\.\//, "")
		.replace(/^packages\/[^/]+\//, "")
		.replace(/^src\//, "")
		.replace(/\.(ts|tsx|js|mjs)$/, "");
}

/**
 * Whether any test file's bytes contain `needle`, by reading the corpus again.
 *
 * The token index above cannot hold a path with a space or a bracket in it, and answering "not
 * found" for one would silently promote that module into the recorded set. No shipped module is
 * named that way today, so this reads nothing today; it is here so the index is a speedup rather
 * than a narrowing of what route 3 asks.
 */
function corpusContains(needle: string): boolean {
	for (const file of testFiles()) {
		if (fs.readFileSync(path.join(REPO_ROOT, file), "utf8").includes(needle)) return true;
	}
	return false;
}

/**
 * The modules no test names, by three routes in ascending cost: an exact module key, a bare path
 * segment (which covers a barrel or a basename reference), and a raw substring scan for the handful
 * neither route matched.
 *
 * A key that is itself a shipped module path contributes no segments. That reference is already
 * spent on the exact step, and letting it also credit a same-named module in another package is the
 * one way this can over-report: a test importing `swarm/pipeline` would otherwise mark
 * `commit/pipeline` covered, which is the opposite of what a floor is for.
 */
function unnamedModules(): string[] {
	const keys = new Set<string>();
	const tokens = new Set<string>();

	for (const file of testFiles()) {
		const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		for (const match of text.matchAll(QUOTED_PATH)) keys.add(moduleKey(match[1] ?? ""));
		for (const token of text.match(PATH_TOKEN) ?? []) tokens.add(token);
	}
	const index = [...tokens].join("\n");

	const shipped = shippedModules();
	const shippedSuffixes = new Set<string>();
	for (const file of shipped) {
		const suffix = SRC_SUFFIX.exec(file)?.[1];
		if (suffix !== undefined) shippedSuffixes.add(suffix);
	}

	const segments = new Set<string>();
	for (const key of keys) {
		if (shippedSuffixes.has(key)) continue;
		for (const segment of key.split("/")) segments.add(segment);
	}

	const unnamed: string[] = [];
	for (const file of shipped) {
		const suffix = SRC_SUFFIX.exec(file)?.[1];
		if (suffix === undefined) continue;
		const base = suffix.slice(suffix.lastIndexOf("/") + 1);
		if (keys.has(suffix) || segments.has(base)) continue;
		if (suffix.endsWith("/index") && keys.has(suffix.slice(0, -"/index".length))) continue;
		if (PATH_CHARS_ONLY.test(suffix) ? index.includes(suffix) : corpusContains(suffix)) continue;
		unnamed.push(file);
	}
	return unnamed.sort();
}

/**
 * Shrink-only. Remove an entry when the module gains a test. Adding one records that a shipped
 * module ships with no test naming it, which should be rare enough to argue about in review.
 *
 * Thirteen entries came out when `testFiles` widened from `<pkg>/test` to the whole
 * package, because a suite sitting beside the module it tests now counts.
 */
const NAMED_BY_NO_TEST: readonly string[] = [
	"packages/agent/src/compaction/legacy-provider-native.ts",
	"packages/agent/src/compaction/remote-compaction-entry.ts",
	"packages/agent/src/tool-result-never-ran.ts",
	"packages/ai/src/auth-broker/refresher.ts",
	"packages/ai/src/auth-broker/remote-store.ts",
	"packages/ai/src/cache/tracker.ts",
	"packages/ai/src/dialect/fenced-thinking.ts",
	"packages/ai/src/error/connect.ts",
	"packages/ai/src/error/domains/request.ts",
	"packages/ai/src/providers/anthropic-messages-server-schema.ts",
	"packages/ai/src/providers/grammar.ts",
	"packages/ai/src/providers/openai-chat-server-schema.ts",
	"packages/ai/src/providers/openai-responses-server-schema.ts",
	"packages/ai/src/providers/synthetic.ts",
	"packages/ai/src/registry/api-key-login.ts",
	"packages/ai/src/registry/baseten.ts",
	"packages/ai/src/registry/llama-cpp.ts",
	"packages/ai/src/registry/minimax-code-cn.ts",
	"packages/ai/src/registry/minimax-code.ts",
	"packages/ai/src/registry/oauth/device-code.ts",
	"packages/ai/src/registry/oauth/pkce.ts",
	"packages/ai/src/registry/oauth/wafer.ts",
	"packages/ai/src/registry/openai-codex-device.ts",
	"packages/ai/src/registry/parallel.ts",
	"packages/ai/src/registry/qianfan.ts",
	"packages/ai/src/registry/qwen-portal.ts",
	"packages/ai/src/registry/sakana.ts",
	"packages/ai/src/registry/tavily.ts",
	"packages/ai/src/registry/together.ts",
	"packages/ai/src/registry/vllm.ts",
	"packages/ai/src/registry/xiaomi-token-plan-ams.ts",
	"packages/ai/src/registry/xiaomi-token-plan-cn.ts",
	"packages/ai/src/registry/xiaomi-token-plan-sgp.ts",
	"packages/ai/src/utils/deterministic-id.ts",
	"packages/ai/src/utils/github-copilot-http.ts",
	"packages/ai/src/utils/openrouter-headers.ts",
	"packages/ai/src/utils/parse-bind.ts",
	"packages/ai/src/utils/provider-fetch.ts",
	"packages/ai/src/utils/schema/adapt.ts",
	"packages/ai/src/utils/schema/compatibility.ts",
	"packages/ai/src/utils/schema/dereference.ts",
	"packages/ai/src/utils/schema/equality.ts",
	"packages/ai/src/utils/schema/fields.ts",
	"packages/ai/src/utils/schema/json-schema-validator.ts",
	"packages/ai/src/utils/schema/meta-validator.ts",
	"packages/ai/src/utils/schema/multiple-of.ts",
	"packages/ai/src/utils/schema/spill.ts",
	"packages/ai/src/utils/schema/stamps.ts",
	"packages/ai/src/utils/schema/strict-tool-validation.ts",
	"packages/ai/src/utils/schema/zod-decontaminate.ts",
	"packages/ai/src/utils/sdk-stream-timeout.ts",
	"packages/catalog/src/discovery/devin-gen/buf/validate/validate_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/analytics_pb/analytics_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/auto_cascade_common_pb/auto_cascade_common_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/bug_checker_pb/bug_checker_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/cascade_plugins_pb/cascade_plugins_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/chat_pb/chat_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/code_edit/code_edit_pb/code_edit_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/context_module_pb/context_module_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/cortex_pb/cortex_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/diff_action_pb/diff_action_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/index_pb/index_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/knowledge_base_pb/knowledge_base_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/language_server_pb/language_server_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/opensearch_clients_pb/opensearch_clients_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/prompt_pb/prompt_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/reactive_component_pb/reactive_component_pb.ts",
	"packages/catalog/src/discovery/devin-gen/exa/trust_pb/trust_pb.ts",
	"packages/catalog/src/provider-models/bundled-references.ts",
	"packages/coding-agent/src/cli/auth-gateway-cli.ts",
	"packages/coding-agent/src/cli/gallery-fixtures/codeintel.ts",
	"packages/coding-agent/src/cli/grep-cli.ts",
	"packages/coding-agent/src/cli/grievances-cli.ts",
	"packages/coding-agent/src/cli/init-xdg.ts",
	"packages/coding-agent/src/cli/read-cli.ts",
	"packages/coding-agent/src/cli/rollback-picker-host.ts",
	"packages/coding-agent/src/cli/session-picker.ts",
	"packages/coding-agent/src/cli/session-stats-cli.ts",
	"packages/coding-agent/src/cli/setup-model-picker.ts",
	"packages/coding-agent/src/cli/stats-cli.ts",
	"packages/coding-agent/src/cli/worktree-cli.ts",
	"packages/coding-agent/src/commands/complete.ts",
	"packages/coding-agent/src/commands/dry-balance.ts",
	"packages/coding-agent/src/commands/gallery.ts",
	"packages/coding-agent/src/commands/gc.ts",
	"packages/coding-agent/src/commands/rollback.ts",
	"packages/coding-agent/src/commands/say.ts",
	"packages/coding-agent/src/commit/agentic/tools/analyze-file.ts",
	"packages/coding-agent/src/commit/agentic/tools/git-hunk.ts",
	"packages/coding-agent/src/commit/agentic/tools/git-overview.ts",
	"packages/coding-agent/src/commit/agentic/tools/propose-changelog.ts",
	"packages/coding-agent/src/commit/agentic/tools/propose-commit.ts",
	"packages/coding-agent/src/commit/analysis/conventional.ts",
	"packages/coding-agent/src/commit/pipeline.ts",
	"packages/coding-agent/src/config/dialect-format.ts",

	"packages/coding-agent/src/debug/remote-debugger.ts",
	"packages/coding-agent/src/discovery/windsurf.ts",
	"packages/coding-agent/src/edit/hashline/params.ts",
	"packages/coding-agent/src/eval/agent-bridge-name.ts",
	"packages/coding-agent/src/eval/py/session-namespace.ts",
	"packages/coding-agent/src/eval/session-id.ts",
	"packages/coding-agent/src/export/markit/converters/docx.ts",
	"packages/coding-agent/src/export/markit/converters/epub.ts",
	"packages/coding-agent/src/export/markit/converters/pptx.ts",
	"packages/coding-agent/src/export/redact-snapshot.ts",
	"packages/coding-agent/src/extensibility/plugins/runtime-config.ts",
	"packages/coding-agent/src/extensibility/session-handler-types.ts",
	"packages/coding-agent/src/internal-urls/relative-path.ts",
	"packages/coding-agent/src/internal-urls/veyyon-protocol.ts",
	"packages/coding-agent/src/lsp/clients/lsp-linter-client.ts",
	"packages/coding-agent/src/lsp/deferred-diagnostics.ts",
	"packages/coding-agent/src/mcp/config-commands.ts",
	"packages/coding-agent/src/mcp/loader.ts",
	"packages/coding-agent/src/mcp/smithery-auth.ts",
	"packages/coding-agent/src/mcp/smithery-connect.ts",
	"packages/coding-agent/src/memory/mnemopi/embed-worker.ts",
	"packages/coding-agent/src/modes/terminal/components/chrome/overlay-box.ts",
	"packages/coding-agent/src/modes/terminal/components/composer/keybinding-hints.ts",
	"packages/coding-agent/src/modes/terminal/components/selectors/select-list-mouse-routing.ts",
	"packages/coding-agent/src/modes/terminal/setup-wizard/scenes/outro.ts",
	"packages/coding-agent/src/modes/terminal/setup-wizard/scenes/wizard-list.ts",
	"packages/coding-agent/src/modes/terminal/skill-command.ts",
	"packages/coding-agent/src/plan-mode/plan-path.ts",
	"packages/coding-agent/src/secrets/standalone-runtime.ts",
	"packages/coding-agent/src/session/classifier-tokens.ts",
	"packages/coding-agent/src/slash-commands/bare-subcommand.ts",
	"packages/coding-agent/src/speech/stt/asr-worker.ts",
	"packages/coding-agent/src/speech/tts/downloader.ts",
	"packages/coding-agent/src/speech/tts/tts-worker.ts",
	"packages/coding-agent/src/theme/before-markdown-theme.ts",
	"packages/coding-agent/src/tools/browser/handle-release.ts",
	"packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
	"packages/coding-agent/src/tools/result-notice.ts",
	"packages/coding-agent/src/tools/text-search-scope.ts",
	"packages/coding-agent/src/web/scrapers/choosealicense.ts",
	"packages/coding-agent/src/web/scrapers/cisa-kev.ts",
	"packages/coding-agent/src/web/scrapers/clojars.ts",
	"packages/coding-agent/src/web/scrapers/crossref.ts",
	"packages/coding-agent/src/web/scrapers/discourse.ts",
	"packages/coding-agent/src/web/scrapers/fdroid.ts",
	"packages/coding-agent/src/web/scrapers/firefox-addons.ts",
	"packages/coding-agent/src/web/scrapers/flathub.ts",
	"packages/coding-agent/src/web/scrapers/jetbrains-marketplace.ts",
	"packages/coding-agent/src/web/scrapers/lemmy.ts",
	"packages/coding-agent/src/web/scrapers/musicbrainz.ts",
	"packages/coding-agent/src/web/scrapers/orcid.ts",
	"packages/coding-agent/src/web/scrapers/rawg.ts",
	"packages/coding-agent/src/web/scrapers/searchcode.ts",
	"packages/coding-agent/src/web/scrapers/snapcraft.ts",
	"packages/coding-agent/src/web/scrapers/sourcegraph.ts",
	"packages/coding-agent/src/web/scrapers/spdx.ts",
	"packages/coding-agent/src/web/scrapers/vscode-marketplace.ts",
	"packages/coding-agent/src/web/search/providers/jina.ts",
	"packages/coding-agent/src/web/search/providers/synthetic.ts",
	"packages/collab-web/src/lib/use-guest.ts",
	"packages/mnemopi/src/util/ids.ts",
	"packages/stats/src/client/components/range-meta.ts",
	"packages/stats/src/client/data/charts.ts",
	"packages/stats/src/client/data/useHashRoute.ts",
	"packages/stats/src/client/data/useResource.ts",
	"packages/tui/src/components/cancellable-loader.ts",
	"packages/tui/src/components/settings-search.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/ansi.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/canvas.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/class-diagram.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/converter.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/draw.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/edge-bundling.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/edge-routing.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/er-diagram.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/grid.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/multiline-utils.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/sequence.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/circle.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/corners.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/hexagon.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/rectangle.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/rounded.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/special.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/shapes/stadium.ts",
	"packages/utils/src/vendor/mermaid-ascii/ascii/xychart.ts",
	"packages/utils/src/vendor/mermaid-ascii/multiline-utils.ts",
	"packages/utils/src/vendor/mermaid-ascii/text-metrics.ts",
	"packages/utils/src/vendor/mermaid-ascii/xychart/colors.ts",
	"packages/utils/src/windows-acl.ts",
];

describe("a shipped module arrives with a test that names it", () => {
	it("scans a corpus large enough for the answer to mean anything", () => {
		expect(shippedModules().length).toBeGreaterThan(1500);
		expect(testFiles().length).toBeGreaterThan(3000);
	});

	// And the corpus reaches every root. A root the walk never opened contributes no module and no
	// test, so its modules are neither required to be named nor able to name anything, and the
	// recorded set below stays exactly as it was.
	it("scans a module and a test under every root the workspace declares", () => {
		const moduleRoots = new Set(shippedModules().map(file => file.split(path.sep)[0]));
		const testRoots = new Set(testFiles().map(file => file.split(path.sep)[0]));

		expect([...moduleRoots].sort()).toEqual(["contracts", "packages"]);
		expect(testRoots.has("contracts")).toBe(true);
	});

	it("has exactly the recorded set of modules that no test names", () => {
		expect(unnamedModules()).toEqual([...NAMED_BY_NO_TEST]);
	});
});

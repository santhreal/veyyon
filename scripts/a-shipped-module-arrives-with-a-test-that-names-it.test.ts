/**
 * WHY THIS EXISTS. A shipped module that no test names is a blind spot nothing reports. A
 * pre-release sweep found twelve of them among the 266 modules changed since v1.2.0, including the
 * Startpage bot-wall refusal and both newly added authentication registries: three paths that had
 * shipped, changed, and never been named by a test. A sweep finds that once. A gate keeps finding it.
 *
 * WHAT IT DOES. It enumerates every shipped TypeScript module under `packages/<pkg>/src` at run time,
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

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** This file lists unnamed modules by path, so counting itself would mark every one of them named. */
const SELF = path.join("scripts", "a-shipped-module-arrives-with-a-test-that-names-it.test.ts");

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
			if (entry.name === "node_modules") continue;
			found.push(...walk(full, keep));
		} else if (keep(full)) {
			found.push(full);
		}
	}
	return found;
}

function packageDirs(): string[] {
	const root = path.join(REPO_ROOT, "packages");
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(root, entry.name));
}

/** Every shipped module: under `src`, TypeScript, not a declaration file and not a test. */
function shippedModules(): string[] {
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

/** Every test file, which is what may name a module. */
function testFiles(): string[] {
	const files: string[] = [];
	for (const pkg of packageDirs()) {
		files.push(...walk(path.join(pkg, "test"), file => file.endsWith(".ts")));
	}
	files.push(...walk(path.join(REPO_ROOT, "scripts"), file => file.endsWith(".test.ts")));
	return files.map(file => path.relative(REPO_ROOT, file)).filter(file => file !== SELF);
}

const QUOTED_PATH = /['"`]([^'"`\n]*\/[^'"`\n]*)['"`]/g;

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
	const texts: string[] = [];

	for (const file of testFiles()) {
		const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		texts.push(text);
		for (const match of text.matchAll(QUOTED_PATH)) keys.add(moduleKey(match[1] ?? ""));
	}
	const corpus = texts.join("\n");

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
		if (corpus.includes(suffix)) continue;
		unnamed.push(file);
	}
	return unnamed.sort();
}

/**
 * Shrink-only. Remove an entry when the module gains a test. Adding one records that a shipped
 * module ships with no test naming it, which should be rare enough to argue about in review.
 */
const NAMED_BY_NO_TEST: readonly string[] = [
	"packages/agent/src/agent-loop-context.ts",
	"packages/agent/src/agent-loop-snapshots.ts",
	"packages/agent/src/agent-loop-stream.ts",
	"packages/agent/src/compaction/compaction-helpers.ts",
	"packages/agent/src/compaction/legacy-provider-native.ts",
	"packages/agent/src/compaction/remote-compaction-entry.ts",
	"packages/agent/src/tool-result-never-ran.ts",
	"packages/ai/src/auth-broker/refresher.ts",
	"packages/ai/src/auth-broker/remote-store.ts",
	"packages/ai/src/auth-storage-helpers.ts",
	"packages/ai/src/cache/tracker.ts",
	"packages/ai/src/dialect/factory.ts",
	"packages/ai/src/dialect/fenced-thinking.ts",
	"packages/ai/src/error/connect.ts",
	"packages/ai/src/error/domains/request.ts",
	"packages/ai/src/providers/amazon-bedrock-helpers.ts",
	"packages/ai/src/providers/anthropic-messages-server-schema.ts",
	"packages/ai/src/providers/anthropic-schema.ts",
	"packages/ai/src/providers/cursor-helpers.ts",
	"packages/ai/src/providers/devin-helpers.ts",
	"packages/ai/src/providers/gitlab-duo-workflow-helpers.ts",
	"packages/ai/src/providers/google-gemini-cli-helpers.ts",
	"packages/ai/src/providers/google-shared-helpers.ts",
	"packages/ai/src/providers/grammar.ts",
	"packages/ai/src/providers/ollama-helpers.ts",
	"packages/ai/src/providers/openai-anthropic-shim.ts",
	"packages/ai/src/providers/openai-chat-server-schema.ts",
	"packages/ai/src/providers/openai-codex-responses-helpers.ts",
	"packages/ai/src/providers/openai-completions-helpers.ts",
	"packages/ai/src/providers/openai-responses-codec-helpers.ts",
	"packages/ai/src/providers/openai-responses-codec.ts",
	"packages/ai/src/providers/openai-responses-helpers.ts",
	"packages/ai/src/providers/openai-responses-server-helpers.ts",
	"packages/ai/src/providers/openai-responses-server-schema.ts",
	"packages/ai/src/providers/openai-shared-helpers.ts",
	"packages/ai/src/providers/synthetic.ts",
	"packages/ai/src/registry/api-key-login.ts",
	"packages/ai/src/registry/baseten.ts",
	"packages/ai/src/registry/llama-cpp.ts",
	"packages/ai/src/registry/lm-studio.ts",
	"packages/ai/src/registry/minimax-code-cn.ts",
	"packages/ai/src/registry/minimax-code.ts",
	"packages/ai/src/registry/mistral.ts",
	"packages/ai/src/registry/oauth/device-code.ts",
	"packages/ai/src/registry/oauth/pkce.ts",
	"packages/ai/src/registry/oauth/success-page.ts",
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
	"packages/ai/src/stream-helpers.ts",
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
	"packages/ai/src/utils/schema/normalize-helpers.ts",
	"packages/ai/src/utils/schema/spill.ts",
	"packages/ai/src/utils/schema/stamps.ts",
	"packages/ai/src/utils/schema/strict-tool-validation.ts",
	"packages/ai/src/utils/schema/zod-decontaminate.ts",
	"packages/ai/src/utils/sdk-stream-timeout.ts",
	"packages/ai/src/utils/validation-helpers.ts",
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
	"packages/catalog/src/provider-models/openai-compat/overrides.ts",
	"packages/catalog/src/provider-models/openai-compat/providers-helpers.ts",
	"packages/catalog/src/provider-models/openai-compat/resolvers.ts",
	"packages/coding-agent/src/autoresearch/dashboard.ts",
	"packages/coding-agent/src/autoresearch/shortcuts.ts",
	"packages/coding-agent/src/cli/auth-gateway-cli.ts",
	"packages/coding-agent/src/cli/commands/init-xdg.ts",
	"packages/coding-agent/src/cli/gallery-fixtures/codeintel.ts",
	"packages/coding-agent/src/cli/gallery-fixtures/misc.ts",
	"packages/coding-agent/src/cli/grep-cli.ts",
	"packages/coding-agent/src/cli/grievances-cli.ts",
	"packages/coding-agent/src/cli/read-cli.ts",
	"packages/coding-agent/src/cli/rollback-picker-host.ts",
	"packages/coding-agent/src/cli/session-picker.ts",
	"packages/coding-agent/src/cli/session-stats-cli.ts",
	"packages/coding-agent/src/cli/setup-model-picker.ts",
	"packages/coding-agent/src/cli/stats-cli.ts",
	"packages/coding-agent/src/cli/update-cli-helpers.ts",
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
	"packages/coding-agent/src/config/model-registry-discovery.ts",
	"packages/coding-agent/src/config/model-registry-overrides.ts",
	"packages/coding-agent/src/config/model-registry-registration.ts",
	"packages/coding-agent/src/config/model-registry-resolution.ts",
	"packages/coding-agent/src/config/model-registry-stage.ts",
	"packages/coding-agent/src/config/model-resolver-helpers.ts",
	"packages/coding-agent/src/config/settings-domains/tasks.ts",
	"packages/coding-agent/src/config/settings-helpers.ts",
	"packages/coding-agent/src/debug/remote-debugger.ts",
	"packages/coding-agent/src/discovery/windsurf.ts",
	"packages/coding-agent/src/edit/hashline/params.ts",
	"packages/coding-agent/src/edit/modes/patch-helpers.ts",
	"packages/coding-agent/src/eval/agent-bridge-name.ts",
	"packages/coding-agent/src/eval/completion-bridge.ts",
	"packages/coding-agent/src/eval/jl/prelude.ts",
	"packages/coding-agent/src/eval/js/shared/prelude.ts",
	"packages/coding-agent/src/eval/py/prelude.ts",
	"packages/coding-agent/src/eval/py/session-namespace.ts",
	"packages/coding-agent/src/eval/rb/prelude.ts",
	"packages/coding-agent/src/eval/session-id.ts",
	"packages/coding-agent/src/export/redact-snapshot.ts",
	"packages/coding-agent/src/extensibility/plugins/marketplace/factory.ts",
	"packages/coding-agent/src/extensibility/plugins/runtime-config.ts",
	"packages/coding-agent/src/extensibility/session-handler-types.ts",
	"packages/coding-agent/src/internal-urls/agent-protocol.ts",
	"packages/coding-agent/src/internal-urls/relative-path.ts",
	"packages/coding-agent/src/internal-urls/veyyon-protocol.ts",
	"packages/coding-agent/src/lsp/clients/lsp-linter-client.ts",
	"packages/coding-agent/src/lsp/deferred-diagnostics.ts",
	"packages/coding-agent/src/lsp/lsp-helpers.ts",
	"packages/coding-agent/src/main-helpers.ts",
	"packages/coding-agent/src/markit/converters/docx.ts",
	"packages/coding-agent/src/markit/converters/epub.ts",
	"packages/coding-agent/src/markit/converters/pptx.ts",
	"packages/coding-agent/src/mcp/config-commands.ts",
	"packages/coding-agent/src/mcp/loader.ts",
	"packages/coding-agent/src/mcp/smithery-auth.ts",
	"packages/coding-agent/src/mcp/smithery-connect.ts",
	"packages/coding-agent/src/mnemopi/embed-worker.ts",
	"packages/coding-agent/src/modes/acp/acp-helpers.ts",
	"packages/coding-agent/src/modes/components/advisor-message.ts",
	"packages/coding-agent/src/modes/components/agent-dashboard-helpers.ts",
	"packages/coding-agent/src/modes/components/agent-model-badge.ts",
	"packages/coding-agent/src/modes/components/collab-prompt-message.ts",
	"packages/coding-agent/src/modes/components/keybinding-hints.ts",
	"packages/coding-agent/src/modes/components/model-hub-helpers.ts",
	"packages/coding-agent/src/modes/components/overlay-box.ts",
	"packages/coding-agent/src/modes/components/pause-screen.ts",
	"packages/coding-agent/src/modes/components/select-list-mouse-routing.ts",
	"packages/coding-agent/src/modes/components/settings-selector-helpers.ts",
	"packages/coding-agent/src/modes/components/settings-submenus.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/compaction-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/effort-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/lsp-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/model-by-depth-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/model-chain-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/model-roles-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/model-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/provider-limits-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/rules-submenu.ts",
	"packages/coding-agent/src/modes/components/settings-submenus/subagent-agents-submenu.ts",
	"packages/coding-agent/src/modes/components/skill-message.ts",
	"packages/coding-agent/src/modes/components/status-line/component-helpers.ts",
	"packages/coding-agent/src/modes/components/status-line/context-usage.ts",
	"packages/coding-agent/src/modes/components/status-line/location-fit.ts",
	"packages/coding-agent/src/modes/controllers/command-controller-helpers.ts",
	"packages/coding-agent/src/modes/controllers/input-controller-helpers.ts",
	"packages/coding-agent/src/modes/controllers/mcp-command-controller-helpers.ts",
	"packages/coding-agent/src/modes/interactive/command-dispatch.ts",
	"packages/coding-agent/src/modes/interactive/event-handlers.ts",
	"packages/coding-agent/src/modes/interactive/goal-mode-controller.ts",
	"packages/coding-agent/src/modes/interactive/lifecycle.ts",
	"packages/coding-agent/src/modes/interactive/plan-mode-controller.ts",
	"packages/coding-agent/src/modes/interactive/todo-board-manager.ts",
	"packages/coding-agent/src/modes/interactive/working-loader-manager.ts",
	"packages/coding-agent/src/modes/setup-wizard/scenes/outro.ts",
	"packages/coding-agent/src/modes/setup-wizard/scenes/wizard-list.ts",
	"packages/coding-agent/src/modes/skill-command.ts",
	"packages/coding-agent/src/modes/theme/before-markdown-theme.ts",
	"packages/coding-agent/src/modes/utils/interactive-context-helpers.ts",
	"packages/coding-agent/src/plan-mode/plan-path.ts",
	"packages/coding-agent/src/sdk-helpers.ts",
	"packages/coding-agent/src/secrets/obfuscator-helpers.ts",
	"packages/coding-agent/src/secrets/standalone-runtime.ts",
	"packages/coding-agent/src/secrets/vault-helpers.ts",
	"packages/coding-agent/src/session/agent-session-helpers.ts",
	"packages/coding-agent/src/session/classifier-tokens.ts",
	"packages/coding-agent/src/session/session-drafts.ts",
	"packages/coding-agent/src/session/session-entry-index.ts",
	"packages/coding-agent/src/session/session-lifecycle.ts",
	"packages/coding-agent/src/session/session-manager-helpers.ts",
	"packages/coding-agent/src/session/side-complete.ts",
	"packages/coding-agent/src/slash-commands/bare-subcommand.ts",
	"packages/coding-agent/src/slash-commands/builtin-registry-helpers.ts",
	"packages/coding-agent/src/stt/asr-worker.ts",
	"packages/coding-agent/src/task/executor-helpers.ts",
	"packages/coding-agent/src/task/index-helpers.ts",
	"packages/coding-agent/src/task/render-helpers.ts",
	"packages/coding-agent/src/tools/ask-helpers.ts",
	"packages/coding-agent/src/tools/bash-helpers.ts",
	"packages/coding-agent/src/tools/browser/cmux/cmux-tab-helpers.ts",
	"packages/coding-agent/src/tools/browser/handle-release.ts",
	"packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
	"packages/coding-agent/src/tools/browser/tab-worker-helpers.ts",
	"packages/coding-agent/src/tools/fetch-helpers.ts",
	"packages/coding-agent/src/tools/gh-helpers.ts",
	"packages/coding-agent/src/tools/grep-helpers.ts",
	"packages/coding-agent/src/tools/image-gen-helpers.ts",
	"packages/coding-agent/src/tools/irc-render.ts",
	"packages/coding-agent/src/tools/read-helpers.ts",
	"packages/coding-agent/src/tools/read-render-helpers.ts",
	"packages/coding-agent/src/tools/result-notice.ts",
	"packages/coding-agent/src/tools/todo-helpers.ts",
	"packages/coding-agent/src/tts/downloader.ts",
	"packages/coding-agent/src/tts/tts-worker.ts",
	"packages/coding-agent/src/tui/width-aware-text.ts",
	"packages/coding-agent/src/utils/git-helpers.ts",
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
	"packages/metaharness/src/bench-report.ts",
	"packages/metaharness/src/launch-args.ts",
	"packages/mnemopi/src/util/ids.ts",
	"packages/simulations/src/cache-sim/harness.ts",
	"packages/simulations/src/paint-sim/harness.ts",
	"packages/simulations/src/turn-sim/invariants.ts",
	"packages/stats/src/client/components/range-meta.ts",
	"packages/stats/src/client/data/charts.ts",
	"packages/stats/src/client/data/useHashRoute.ts",
	"packages/stats/src/client/data/useResource.ts",
	"packages/tui/src/components/cancellable-loader.ts",
	"packages/tui/src/components/editor-helpers.ts",
	"packages/tui/src/components/markdown-helpers.ts",
	"packages/tui/src/components/settings-search.ts",
	"packages/tui/src/tui-helpers.ts",
	"packages/typescript-edit-benchmark/src/edit-prompt-bench.ts",
	"packages/typescript-edit-benchmark/src/goal-budget-context-bench.ts",
	"packages/typescript-edit-benchmark/src/in-process-client.ts",
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

	it("has exactly the recorded set of modules that no test names", () => {
		expect(unnamedModules()).toEqual([...NAMED_BY_NO_TEST]);
	});
});

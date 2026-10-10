/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `interactive-mode.ts` built the `/mcp`, `/ssh`, `/tan` and `/todo` command
 * controllers in its constructor, `voice-controller.ts` imported the speech-to-text recorder, model
 * downloader and recogniser with the composer, and `tools/shell/debug.ts` imported the DAP protocol
 * client and session manager with the check that registers the tool. The slash-command registry
 * imported the `/secret`, `/mcp` and `/ssh` handlers and the plugin manager, the command controller
 * imported the Hindsight mental-model helpers for `/memory mm`, the extension UI controller imported
 * the autoresearch run screen and launcher, and the bundled `/review` command imported the GitHub
 * client. Every interactive session parsed and compiled all of it before a command was typed, the
 * push-to-talk key was pressed or a debugger was launched.
 *
 * THE CLASS. Machinery that only a command, a key binding or a tool action reaches is not in the
 * static import graph of the module that dispatches to it. Each member set is read from its directory
 * at run time and the eager subset is pinned by exact equality, so a new controller, recogniser module
 * or DAP module that loads eagerly turns this red until it is recorded here. A new module that loads on
 * demand leaves it green.
 *
 * WHAT IT DOES NOT CATCH. The walk is static: a module reached through `await import(...)` is outside
 * it by design, and the suite says nothing about what a module costs once loaded. Behaviour after the
 * first load is asserted where it lives: `todo-command-controller.test.ts`,
 * `tan-command-controller.test.ts` and the `mcp-command-*` suites drive the controllers,
 * `a-recording-owns-the-cursor-and-gives-it-back.test.ts` drives push-to-talk through the lazily
 * loaded `STTController`, `debug/dap-launch-failures.test.ts` drives `DebugTool.execute` through
 * the lazily loaded session manager, `print-mode-secret-command.test.ts` drives `/secret` through
 * the registry, and `extensibility/custom-commands/review.test.ts` drives
 * `/review <pr>` through the lazily loaded GitHub client.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildStartupImportGraph, type StartupImportGraph } from "./helpers/startup-import-graph";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SRC = path.join(REPO_ROOT, "packages/coding-agent/src");

const interactiveSession = buildStartupImportGraph(REPO_ROOT, path.join(SRC, "modes/terminal/interactive-mode.ts"));
const debugTool = buildStartupImportGraph(REPO_ROOT, path.join(SRC, "tools/shell/debug.ts"));

/** The files of `dir` (relative to `src/`) that `graph` reaches statically, by name. */
function reachedIn(graph: StartupImportGraph, dir: string): string[] {
	const absolute = path.join(SRC, dir);
	return fs
		.readdirSync(absolute)
		.filter(name => !name.endsWith(".test.ts") && graph.files.has(path.join(absolute, name)))
		.sort();
}

describe("an interactive session's static import graph", () => {
	test("is complete enough to judge by", () => {
		expect(interactiveSession.unscannable).toEqual([]);
		expect(interactiveSession.files.size).toBeGreaterThan(1_000);
	});

	test("holds exactly the controllers the session drives before any command", () => {
		// Every other controller in the directory opens with its command: `/mcp`, `/ssh`, `/tan`,
		// `/todo`, the selector cards and the setting effects they apply. The event controller builds
		// `composer-prediction-controller.ts` with itself, since a prediction follows every finished turn.
		expect(reachedIn(interactiveSession, "modes/terminal/controllers")).toEqual([
			"btw-controller.ts",
			"command-controller-shared.ts",
			"command-controller.ts",
			"composer-prediction-controller.ts",
			"event-controller.ts",
			"extension-ui-controller.ts",
			"goal-mode-controller.ts",
			"home-anchor-layout.ts",
			"input-controller.ts",
			"omfg-controller.ts",
			"omfg-rule.ts",
			"session-focus-controller.ts",
			"streaming-reveal.ts",
			"tiny-title-download-row.ts",
			"tool-args-reveal.ts",
			"transcript-composer.ts",
			"voice-controller.ts",
			"welcome-controller.ts",
			"working-loader.ts",
		]);
	});

	test("holds the speech-to-text option tables and not the recorder or the recogniser", () => {
		// `models.ts` and `submit-trigger.ts` are the option tables the settings domain declares
		// `stt.model` and `stt.submitTrigger` from.
		expect(reachedIn(interactiveSession, "speech/stt")).toEqual(["models.ts", "submit-trigger.ts"]);
	});

	test("holds the slash-command helpers the session renders before any command", () => {
		// `secret.ts`, `mcp.ts` and `ssh.ts` load on the first `/secret`, `/mcp` or `/ssh`.
		expect(reachedIn(interactiveSession, "slash-commands/helpers")).toEqual([
			"account-status.ts",
			"active-oauth-account.ts",
			"collab-qrcode.ts",
			"context-report.ts",
			"cpu-limit.ts",
			"format.ts",
			"parse.ts",
			"reset-usage.ts",
			"stats-dashboard.ts",
			"todo.ts",
			"usage-report.ts",
		]);
	});

	test("holds the session's secret runtime and not the `/secret` command parser", () => {
		// `secret-verbs.ts` is the completion menu; `expiry.ts` is the startup expiry warnings.
		expect(reachedIn(interactiveSession, "secrets")).toEqual([
			"atomic-path.ts",
			"audit.ts",
			"env-keywords.ts",
			"env-keywords.yml",
			"expiry.ts",
			"index.ts",
			"notices.ts",
			"obfuscator.ts",
			"placeholder.ts",
			"policy.ts",
			"regex.ts",
			"request-leases.ts",
			"secret-verbs.ts",
			"session-runtime.ts",
			"spend-marker.ts",
			"vault-crypto.ts",
			"vault.ts",
		]);
	});

	test("holds the plugin loader and not the `/plugins` manager", () => {
		expect(reachedIn(interactiveSession, "extensibility/plugins")).toEqual(["legacy-pi-compat.ts", "loader.ts"]);
	});

	test("holds the transcript readers memory recall shares and not the `/memory mm` helpers", () => {
		expect(reachedIn(interactiveSession, "memory/hindsight")).toEqual(["content.ts", "transcript.ts"]);
	});

	test("holds the GitHub card renderers and not the `/review <pr>` client", () => {
		expect(reachedIn(interactiveSession, "tools/web")).toEqual([
			"fetch-view.ts",
			"gh-fetch.ts",
			"gh-format.ts",
			"gh-url.ts",
			"gh-view.ts",
			"github-cache.ts",
			"image-gen.ts",
			"manifest.ts",
			"read-url-target.ts",
			"tts.ts",
			"xai-http.ts",
		]);
	});

	test("holds the dialogs a session opens unprompted and not the autoresearch screens", () => {
		expect(reachedIn(interactiveSession, "modes/terminal/components/dialogs")).toEqual([
			"ask-dialog.ts",
			"btw-panel.ts",
			"dialog-factory.ts",
			"hook-editor.ts",
			"hook-input.ts",
			"launch-tip.ts",
			"omfg-panel.ts",
			"pause-screen.ts",
			"plan-review-overlay.ts",
			"plan-toc.ts",
			"welcome.ts",
		]);
	});
});

describe("the debug tool's static import graph", () => {
	test("is complete enough to judge by", () => {
		expect(debugTool.unscannable).toEqual([]);
		expect(debugTool.files.size).toBeGreaterThan(100);
	});

	test("holds the adapter config the registration check reads and not the protocol client", () => {
		expect(reachedIn(debugTool, "debug/dap")).toEqual(["config.ts", "defaults.json"]);
	});
});

/**
 * WHY: the terminal renderer is supposed to draw view-models, and a renderer
 * that reads an `AgentMessage` instead of a `TranscriptBlock` is a renderer the
 * browser client cannot be written from. The defect class is a file under
 * `modes/terminal/` that reaches back into `session/` or `@veyyon/agent-core`
 * for one field the view-model does not carry yet — after which the contract
 * exists on paper and the coupling is back.
 *
 * The view-model layer this decoupling created — `driver.ts`, `block-rows.ts`,
 * `chrome-rows.ts`, `theme-ansi.ts` — reads the runtime nowhere, pinned by
 * exact equality. The rest of the terminal tree predates the contract and still
 * reads sessions directly; every such module is recorded below by name, so a
 * module that starts reading the runtime turns this red, and the list can only
 * shrink as modules move onto the driver.
 *
 * What it does NOT catch: a view-model field whose value the renderer
 * interprets as though it were a runtime object.
 */

import { describe, expect, test } from "bun:test";
import {
	importSpecifiers,
	isDirectory,
	reachableFrom,
	repoPath,
	repoRelative,
	typeScriptFiles,
} from "./helpers/module-graph";

const TERMINAL = repoPath("packages/coding-agent/src/modes/terminal");

/** The modules written against `PresentationContext`. They see no runtime. */
const VIEW_MODEL_LAYER: readonly string[] = ["driver.ts", "block-rows.ts", "chrome-rows.ts", "theme-ansi.ts"];

/**
 * Terminal modules that still read a session directly, relative to
 * `modes/terminal/`. Every entry is a module the driver has not taken over yet.
 * Adding a row records a decision; the list is expected to shrink, never grow.
 */
const LEGACY_RUNTIME_READERS: readonly string[] = [
	"components/account/account-manager-rows.ts",
	"components/account/account-manager.ts",
	"components/composer/composer-chrome.ts",
	"components/composer/custom-editor.ts",
	"components/composer/history-search.ts",
	"components/dashboard/agent-dashboard.ts",
	"components/dashboard/agent-model-badge.ts",
	"components/dashboard/agent-transcript-viewer.ts",
	"components/dialogs/advisor-config.ts",
	"components/dialogs/pause-screen.ts",
	"components/extensions/inspector-panel.ts",
	"components/selectors/effort-picker.ts",
	"components/selectors/model-browser.ts",
	"components/selectors/model-hub.ts",
	"components/selectors/model-picker.ts",
	"components/selectors/model-selector.ts",
	"components/selectors/oauth-selector.ts",
	"components/selectors/session-selector.ts",
	"components/selectors/settings-selector.ts",
	"components/selectors/thinking-selector.ts",
	"components/selectors/tree-selector.ts",
	"components/status-line/component.ts",
	"components/status-line/segments.ts",
	"components/status-line/types.ts",
	"components/transcript/assistant-message.ts",
	"components/transcript/background-tan-message.ts",
	"components/transcript/cache-invalidation-marker.ts",
	"components/transcript/chat-transcript-builder.ts",
	"components/transcript/collab-prompt-message.ts",
	"components/transcript/compaction-summary-message.ts",
	"components/transcript/custom-message.ts",
	"components/transcript/hook-message.ts",
	"components/transcript/message-frame.ts",
	"components/transcript/read-tool-group.ts",
	"components/transcript/skill-message.ts",
	"components/transcript/tool-execution.ts",
	"components/transcript/usage-row.ts",
	"controllers/btw-controller.ts",
	"controllers/command-controller.ts",
	"controllers/event-controller.ts",
	"controllers/extension-ui-controller.ts",
	"controllers/input-controller.ts",
	"controllers/omfg-rule.ts",
	"controllers/selector-controller.ts",
	"controllers/session-focus-controller.ts",
	"controllers/streaming-reveal.ts",
	"controllers/tan-command-controller.ts",
	"controllers/transcript-composer.ts",
	"image-references.ts",
	"interactive-mode.ts",
	"setup-wizard/scenes/sign-in.ts",
	"skill-command.ts",
	"types.ts",
	"utils/context-usage.ts",
	"utils/copy-targets.ts",
	"utils/interactive-context-helpers.ts",
	"utils/transcript-render-helpers.ts",
	"utils/ui-helpers.ts",
];

/** Runtime specifiers a renderer must not reach for. */
function isRuntimeImport(specifier: string): boolean {
	if (specifier === "@veyyon/agent-core" || specifier.startsWith("@veyyon/agent-core/")) return true;
	if (specifier === "@veyyon/ai" || specifier.startsWith("@veyyon/ai/")) return true;
	return specifier.includes("session/agent-session") || specifier.includes("/session/");
}

function runtimeReaders(): string[] {
	const readers: string[] = [];
	for (const file of typeScriptFiles(TERMINAL)) {
		const relative = repoRelative(file).slice("packages/coding-agent/src/modes/terminal/".length);
		if (relative.endsWith(".test.ts")) continue;
		if (importSpecifiers(file).some(isRuntimeImport)) readers.push(relative);
	}
	return readers.sort();
}

describe("the terminal renderer draws view-models", () => {
	test("the directory exists and holds the driver", () => {
		expect(isDirectory(TERMINAL)).toBe(true);
		const files = typeScriptFiles(TERMINAL).map(repoRelative);
		expect(files).toContain("packages/coding-agent/src/modes/terminal/driver.ts");
	});

	test("no module of the view-model layer reads the agent runtime", () => {
		const offenders = VIEW_MODEL_LAYER.filter(name =>
			importSpecifiers(repoPath(`packages/coding-agent/src/modes/terminal/${name}`)).some(isRuntimeImport),
		);
		expect(offenders).toEqual([]);
	});

	test("only the recorded legacy modules read the agent runtime", () => {
		// Exact equality: a module that starts reading a session has to be added
		// here on purpose, and one that stops has to be removed.
		expect(runtimeReaders()).toEqual([...LEGACY_RUNTIME_READERS].sort());
	});

	test("no module of the view-model layer is on the legacy list", () => {
		const overlap = VIEW_MODEL_LAYER.filter(name => LEGACY_RUNTIME_READERS.includes(name));
		expect(overlap).toEqual([]);
	});

	test("the driver takes its types from the presentation contract", () => {
		const specifiers = importSpecifiers(repoPath("packages/coding-agent/src/modes/terminal/driver.ts"));
		expect(specifiers).toContain("@veyyon/wire/presentation");
		expect(specifiers).toContain("@veyyon/tui");
	});

	test("no module under modes/terminal is dead", () => {
		// A move this size is where dead files hide: nothing imports them, nothing
		// fails, and they read as part of the surface for years. Reachability is
		// walked from the production entry points rather than assumed.
		const roots = [
			repoPath("packages/coding-agent/src/main.ts"),
			repoPath("packages/coding-agent/src/index.ts"),
			repoPath("packages/coding-agent/src/modes/terminal/interactive-mode.ts"),
			repoPath("packages/coding-agent/src/modes/terminal/driver.ts"),
			repoPath("packages/coding-agent/src/modes/terminal/first-frame.ts"),
		];
		const reachable = reachableFrom(roots);
		const unreachable = typeScriptFiles(TERMINAL)
			.filter(file => !file.endsWith(".test.ts") && !reachable.has(file))
			.map(file => repoRelative(file).slice("packages/coding-agent/src/modes/terminal/".length))
			.sort();
		// The oracle is a shipped module the suites drive against real frames; it is
		// reached from tests only, on purpose.
		expect(unreachable).toEqual(["components/composer/composer-defect-oracle.ts"]);
	});
});

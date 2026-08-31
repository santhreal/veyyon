/**
 * The subtrees {@link warmRuntimeGraph} loads, in the order it loads them.
 *
 * Separated from the loader so the list reads as data: one line per subtree,
 * ordered from the packages everything sits on to the interactive mode that
 * sits on all of them. Each entry is a literal specifier that `../main` imports
 * transitively, so warming is a reordering of work the launch already does.
 *
 * The dynamic import is the mechanism, not a shortcut: a static import here
 * would be folded back into `../main`'s one synchronous evaluation chain and
 * the loop would stop turning between subtrees, which is the whole point of
 * the file. See {@link warmRuntimeGraph} for the measurement.
 *
 * Each stage carries the specifier as its name so the `VEYYON_TIMING` tree
 * prices the subtrees against each other on the machine being measured. The
 * numbers below are from a source run (about 2.5x a compiled binary), which is
 * why the tree and not this table is the thing to read before splitting one:
 *
 * | stage                | cost  |
 * | -------------------- | ----- |
 * | arktype              | 101ms |
 * | @veyyon/utils        |  65ms |
 * | @veyyon/ai           |  54ms |
 * | catalog models       |  36ms |
 * | @veyyon/tui          |  25ms |
 * | advisor              |  39ms |
 * | session/agent-session|  82ms |
 * | modes/interactive    | 108ms |
 *
 * A stage worth more than about 50ms compiled is a candidate for splitting into
 * its own heavy children; the four monoliths above were split that way already.
 * `arktype` is the floor: one npm module, 89 importers, nothing to split.
 */

export interface WarmupStage {
	/** The specifier, used as the span name in the `VEYYON_TIMING` tree. */
	readonly name: string;
	readonly load: () => Promise<unknown>;
}

export const WARMUP_STAGES: readonly WarmupStage[] = [
	// Schema runtime under every tool, hook and custom command definition.
	{ name: "arktype", load: () => import("arktype") },
	{ name: "@veyyon/utils", load: () => import("@veyyon/utils") },
	// The model catalog: `models.json` is 2.2MB of literal that parses here
	// rather than inside the provider graph below.
	{ name: "@veyyon/catalog/models", load: () => import("@veyyon/catalog/models") },
	{ name: "@veyyon/catalog/provider-models", load: () => import("@veyyon/catalog/provider-models") },
	{ name: "@veyyon/ai", load: () => import("@veyyon/ai") },
	{ name: "@veyyon/agent-core", load: () => import("@veyyon/agent-core") },
	{ name: "@veyyon/tui", load: () => import("@veyyon/tui") },
	{ name: "advisor", load: () => import("../advisor") },
	{ name: "config/model-registry", load: () => import("../config/model-registry") },
	{ name: "mcp", load: () => import("../mcp") },
	{ name: "memory/backend", load: () => import("../memory/backend") },
	{ name: "extensibility/custom-commands", load: () => import("../extensibility/custom-commands") },
	{ name: "tools/vibe", load: () => import("../tools/agent/vibe") },
	{ name: "edit/modes/patch", load: () => import("../edit/modes/patch") },
	{ name: "session/agent-session", load: () => import("../session/agent-session") },
	{ name: "sdk", load: () => import("../sdk") },
	{ name: "slash-commands/builtin-registry", load: () => import("../slash-commands/builtin-registry") },
	{
		name: "modes/terminal/controllers/event-controller",
		load: () => import("../modes/terminal/controllers/event-controller"),
	},
	{
		name: "modes/terminal/controllers/tan-command-controller",
		load: () => import("../modes/terminal/controllers/tan-command-controller"),
	},
	{
		name: "modes/terminal/controllers/selector-controller",
		load: () => import("../modes/terminal/controllers/selector-controller"),
	},
	{ name: "modes/terminal/interactive-mode", load: () => import("../modes/terminal/interactive-mode") },
];

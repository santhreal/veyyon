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
 * Costs below are from a source run (about 2.5x a compiled binary), measured by
 * importing each stage behind a yield and timing it:
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

export const WARMUP_STAGES: readonly (() => Promise<unknown>)[] = [
	// Schema runtime under every tool, hook and custom command definition.
	() => import("arktype"),
	() => import("@veyyon/utils"),
	// The model catalog: `models.json` is 2.2MB of literal that parses here
	// rather than inside the provider graph below.
	() => import("@veyyon/catalog/models"),
	() => import("@veyyon/catalog/provider-models"),
	() => import("@veyyon/ai"),
	() => import("@veyyon/agent-core"),
	() => import("@veyyon/tui"),
	() => import("../advisor"),
	() => import("../config/model-registry"),
	() => import("../mcp"),
	() => import("../memory/backend"),
	() => import("../extensibility/custom-commands"),
	() => import("../tools/vibe"),
	() => import("../edit/modes/patch"),
	() => import("../session/agent-session"),
	() => import("../sdk"),
	() => import("../slash-commands/builtin-registry"),
	() => import("../modes/terminal/controllers/event-controller"),
	() => import("../modes/terminal/controllers/tan-command-controller"),
	() => import("../modes/terminal/controllers/selector-controller"),
	() => import("../modes/terminal/interactive-mode"),
];

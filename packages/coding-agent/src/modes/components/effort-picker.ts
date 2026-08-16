/**
 * The one place that builds a thinking-effort variant picker.
 *
 * The active model supplies the valid names. Every caller gets the same base,
 * auto, off, and native-variant semantics without presenting choices that the
 * model will only clamp or ignore.
 */
import type { Model } from "@veyyon/ai";
import { type Container, type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { formatModelSelectorValue, parseModelString } from "../../config/model-resolver";
import { configuredThinkingLevelOptions, noSelectableEffortNotice, parseConfiguredThinkingLevel } from "../../thinking";
import { getSelectListTheme, theme } from "../theme/theme";

/** The label the suffix-free base row carries here: this picker sits under a model. */
const MODEL_DEFAULT_LABEL = "Model default";

/**
 * Valid effort rows for the selected model, with the suffix-free base first.
 *
 * `scope` is for the one row that has no model and never will — Default Effort's
 * any-model `*` row. It offers the union of what the session's catalog declares
 * rather than the whole vocabulary, so a level nothing here accepts is never a
 * row. With neither a model nor a scope only the base row remains.
 */
export function effortStepItems(model?: Model, scope?: ReadonlyArray<Model>): SelectItem[] {
	return configuredThinkingLevelOptions({
		model,
		scope,
		inheritLabel: MODEL_DEFAULT_LABEL,
		inheritDescription: "Use this model's own default reasoning",
	}).map(option => ({ ...option }));
}

/**
 * Human summary of a stored model selector for a settings row: renders the
 * effort suffix as a readable ` · high` (e.g. `anthropic/claude-sonnet-4-5 · high`)
 * instead of the raw `:high` token, and returns the bare selector unchanged when
 * it carries no effort. Uses the same parser the resolver does, so a model id
 * that legitimately ends in a colon token is left intact. One owner so the
 * single-slot rows and the role list read identically.
 */
export function formatSelectorSummary(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed);
	return parsed?.thinkingLevel ? `${parsed.provider}/${parsed.id} · ${parsed.thinkingLevel}` : trimmed;
}

/**
 * Render the model's valid effort variants and return its keyboard-routed list.
 *
 * Selecting a named variant appends its `:level` suffix. The first row stores
 * the bare model selector, matching OpenCode's explicit "default" variant.
 */
export function renderEffortStep(
	container: Container,
	selector: string,
	model: Model | undefined,
	onPersist: (value: string) => void,
	onBack: () => void,
	/** The catalog a model-less row spans; see {@link effortStepItems}. */
	scope?: ReadonlyArray<Model>,
): SelectList {
	container.clear();
	const items = effortStepItems(model, scope);
	const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
	list.onSelect = item => {
		const level = item.value ? parseConfiguredThinkingLevel(item.value) : undefined;
		onPersist(formatModelSelectorValue(selector, level));
	};
	list.onCancel = onBack;
	container.addChild(new Text(theme.bold(theme.fg("accent", "Thinking effort")), 0, 0));
	container.addChild(new Spacer(1));
	// A model whose effort lives in sibling model ids narrows to nothing, leaving the
	// base row alone. Saying "valid effort variants" over a one-row list reads as a
	// broken screen, which is what the Subagent Effort row already learned; the
	// sentence has one owner so both surfaces say the same thing.
	const heading =
		items.length <= 1
			? model !== undefined
				? noSelectableEffortNotice(MODEL_DEFAULT_LABEL)
				: `No model in this session declares a selectable effort, so only ${MODEL_DEFAULT_LABEL} applies.`
			: `Valid effort variants for ${selector}.`;
	container.addChild(new Text(theme.fg("muted", heading), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(list);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", "  Enter / click pick · Esc back to model"), 0, 0));
	return list;
}

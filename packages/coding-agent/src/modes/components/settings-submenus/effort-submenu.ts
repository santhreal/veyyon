import type { Model } from "@veyyon/ai";
import { matchesKey, type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import { ANY_MODEL_EFFORT_KEY, withLegacyDefaultEffort } from "../../../config/effort-resolver";
import type { ModelRegistry } from "../../../config/model-registry";
import { extractExplicitThinkingSelector } from "../../../config/model-resolver";
import { settings } from "../../../config/settings";
import { getSelectListTheme, theme } from "../../theme/theme";
import { renderEffortStep } from "../effort-picker";
import { pointerMotionEnabled } from "../modal-shell";
import { ModelSelectorPanel } from "../model-selector";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";

export const EFFORT_SUBMENU_PATHS: Readonly<Record<string, true>> = { "subagent.thinkingLevel": true };

const ADD_EFFORT_ROW = "\u0000add-effort-row";

export class DefaultEffortSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly models: ReadonlyArray<Model>,
		private readonly registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showRows();
	}

	#rows(): Record<string, string> {
		return withLegacyDefaultEffort(
			settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
			settings.get("defaultThinkingLevel"),
		);
	}

	#showRows(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Default Effort")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Effort applied when a run does not ask for one. A model's own row wins over the any-model row. Per active profile.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const rows = this.#rows();
		const keys = Object.keys(rows).sort((a, b) =>
			a === ANY_MODEL_EFFORT_KEY ? -1 : b === ANY_MODEL_EFFORT_KEY ? 1 : a.localeCompare(b),
		);
		const items: SelectItem[] = keys.map(key => ({
			value: key,
			label: key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			description: rows[key] ?? "",
		}));
		items.push({ value: ADD_EFFORT_ROW, label: "Add a model…", description: "pick a model, then its effort" });
		items.push({
			value: ANY_MODEL_EFFORT_KEY,
			label: rows[ANY_MODEL_EFFORT_KEY] === undefined ? "Set the any-model effort…" : "Change the any-model effort…",
			description: "applies to every model without its own row",
		});

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === ADD_EFFORT_ROW) {
				this.#showModelPicker();
			} else {
				this.#showEffortPicker(item.value);
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit · Del removes a row · Esc to go back"), 0, 0));
	}

	#showModelPicker(): void {
		this.clear();
		this.#selectList = undefined;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: "Default effort for which model",
				description: "Pick the model, then its effort. Already-listed models are edited from the list itself.",
				allowClear: false,
			},
			{
				onPick: model => {
					this.#showEffortPicker(`${model.provider}/${model.id}`, model);
					this.requestRender?.();
				},
				onCancel: () => {
					this.#showRows();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(key: string, picked?: Model): void {
		const model = picked ?? this.models.find(m => `${m.provider}/${m.id}` === key);
		this.#selectList = renderEffortStep(
			this,
			key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			key === ANY_MODEL_EFFORT_KEY ? undefined : model,
			value => this.#persist(key, value),
			() => {
				this.#showRows();
				this.requestRender?.();
			},
			key === ANY_MODEL_EFFORT_KEY ? this.models : undefined,
		);
	}

	#persist(key: string, selectorWithEffort: string): void {
		const level = extractExplicitThinkingSelector(selectorWithEffort, settings);
		const rows = { ...this.#rows() };
		if (level === undefined) delete rows[key];
		else rows[key] = level;
		settings.set("defaultEffort", rows);
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	#removeSelectedRow(): void {
		const selected = this.#selectList?.getSelectedItem?.();
		const key = selected?.value;
		if (!key || key === ADD_EFFORT_ROW) return;
		const rows = { ...this.#rows() };
		if (rows[key] === undefined) return;
		delete rows[key];
		settings.set("defaultEffort", rows);
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
		);
	}

	handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

import type { Api, Model } from "@veyyon/ai";
import { type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import type { ModelRegistry } from "../../../config/model-registry";
import { getRoleInfo, ROLE_INHERIT_LABEL, SELECTABLE_MODEL_ROLE_IDS } from "../../../config/model-roles";
import { settings } from "../../../config/settings";
import { hasConfigurableThinkingEffort } from "../../../thinking";
import { getSelectListTheme, theme } from "../../theme/theme";
import { formatSelectorSummary, renderEffortStep } from "../effort-picker";
import { pointerMotionEnabled } from "../modal-shell";
import { ModelSelectorPanel } from "../model-selector";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";

import { barePickerSelector } from "./model-roles-submenu-helpers";

export { replaceModelChainEntry } from "./model-roles-submenu-helpers";
export { barePickerSelector };

export class ModelRolesSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#models: ReadonlyArray<Model>;
	#registry: ModelRegistry;

	constructor(
		models: ReadonlyArray<Model>,
		registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#models = models;
		this.#registry = registry;
		this.#showRoleList();
	}

	#showRoleList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Role Models")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Assign a model per role. Searchable picker · auth status on each row. Per active profile.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const items: SelectItem[] = SELECTABLE_MODEL_ROLE_IDS.map((role: string) => {
			const info = getRoleInfo(role, settings);
			const assigned = settings.getModelRole(role)?.trim();
			return {
				value: role,
				label: info.name,
				description:
					assigned && assigned.length > 0
						? formatSelectorSummary(assigned)
						: (info.unsetLabel ?? ROLE_INHERIT_LABEL),
			};
		});
		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#showModelPicker(item.value);
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to pick model · Esc to go back"), 0, 0));
	}

	#showModelPicker(role: string): void {
		this.clear();
		this.#selectList = undefined;
		const info = getRoleInfo(role, settings);
		const current = settings.getModelRole(role)?.trim();
		const panel = new ModelSelectorPanel(
			settings,
			this.#registry,
			this.#models,
			{
				title: `${info.name} model`,
				description: `Role \`${role}\` — used when that work type runs. Del or the (inherit) row clears (${info.unsetLabel ?? "inherit main model"}).`,
				currentSelector: barePickerSelector(current, this.#models as Model<Api>[]),
				allowClear: true,
			},
			{
				onPick: (model, selector) => {
					if (!hasConfigurableThinkingEffort(model)) {
						this.#persistRole(role, selector);
						return;
					}
					this.#showEffortPicker(role, selector, model);
					this.requestRender?.();
				},
				onClear: () => {
					settings.setModelRole(role, undefined);
					this.onChange();
					this.#showRoleList();
					this.requestRender?.();
				},
				onCancel: () => {
					this.#showRoleList();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(role: string, selector: string, model: Model): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			model,
			value => this.#persistRole(role, value),
			() => {
				this.#showModelPicker(role);
				this.requestRender?.();
			},
		);
	}

	#persistRole(role: string, value: string): void {
		settings.setModelRole(role, value);
		this.onChange();
		this.#showRoleList();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return this.#selectList ?? this.#pickerPanel();
	}

	#pickerPanel(): ModelSelectorPanel | undefined {
		return this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel);
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

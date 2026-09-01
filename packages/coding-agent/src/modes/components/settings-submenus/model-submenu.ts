import type { Api, Model } from "@veyyon/ai";
import type { ModelRegistry } from "../../../config/model-registry";
import { DEFAULT_MODEL_SLOT } from "../../../config/model-roles";
import { settings } from "../../../config/settings";
import { pointerMotionEnabled } from "../modal-shell";
import { ModelSelectorPanel } from "../model-selector";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { barePickerSelector } from "./model-roles-submenu";

export class DefaultModelSubmenu extends MouseRoutedSubmenu {
	constructor(
		private readonly models: ReadonlyArray<Model>,
		private readonly registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showModelPicker();
	}

	#showModelPicker(): void {
		this.clear();
		const current = settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)?.trim();
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: "Default model",
				description: "The model each new session starts on. Clearing the pin auto-selects on launch.",
				currentSelector: barePickerSelector(current, this.models as Model<Api>[]),
				allowClear: true,
				clearLabel: "(auto-select on launch)",
			},
			{
				onPick: (_model, selector) => this.#persist(selector),
				onClear: () => {
					settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, undefined);
					this.onChange();
					this.onCancel();
				},
				onCancel: () => this.onCancel(),
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#persist(selector: string): void {
		settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, selector);
		this.onChange();
		this.onCancel();
	}

	mouseTarget(): ModelSelectorPanel | undefined {
		return this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel);
	}

	handleInput(data: string): void {
		this.children[0]?.handleInput?.(data);
	}
}

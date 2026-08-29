import type { Model } from "@veyyon/ai";
import {
	type Component,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";
import type { ModelPickerCallbacks, ModelPickerOptions } from "./model-picker-helpers";
import {
	BROWSER_FRAME_ROWS,
	MIN_VISIBLE,
	REFRESH_HINT,
	REFRESH_HINT_SHORT,
	REFRESHING_HINT,
	STATUS_HINT,
} from "./model-picker-helpers";

export type { ModelPickerOptions };

export class ModelPickerComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#configError: string | undefined;
	#currentSelector: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#shellGeometry: ModalShellGeometry | null = null;
	#browserRowStart = 0;
	#hoveredShortcutId: string | null = null;
	#refreshing = false;
	#onCancel: () => void;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#currentSelector = options.currentSelector;
		this.#onCancel = callbacks.onCancel;

		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			disableOverContext: true,
		});
		this.#browser.onActivate = item => {
			callbacks.onPick(item.model, item.selector);
		};
		this.#browser.onCancel = () => callbacks.onCancel();
		this.#browser.onQueryChange = () => this.#syncFromRegistryState();
		this.#browser.setHoverMotion({
			requestRender: () => this.#tui.requestRender(),
			enabled: pointerMotionEnabled(),
		});

		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = errorMessage(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	dispose(): void {
		this.#browser.disposeHoverMotion();
	}

	invalidate(): void {}

	#syncFromRegistryState(): void {
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? errorMessage(loadError) : undefined;
			try {
				models = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = errorMessage(error);
				models = [];
			}
		}

		const allModels = this.#scopedModels.length > 0 ? models : this.#registry.getAll();
		const roles = resolveRoleAssignments(this.#settings, allModels);
		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		this.#modelItems = buildBrowserItems(models);
		sortModelItems(this.#modelItems, { roles, mruOrder });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#browser.setCurrentSelector(this.#currentSelector);
		this.#browser.setItems(this.#modelItems);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.#refreshCatalog();
			return;
		}
		this.#browser.handleInput(data);
	}

	#refreshCatalog(): void {
		if (this.#refreshing) return;
		this.#refreshing = true;
		this.#configError = undefined;
		this.#tui.requestRender();
		this.#registry
			.refresh("online")
			.then(() => this.#syncFromRegistryState())
			.catch(error => {
				this.#configError = errorMessage(error);
			})
			.finally(() => {
				this.#refreshing = false;
				this.#tui.requestRender();
			});
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#tui.requestRender();
			})
		) {
			return true;
		}
		if (chrome.kind === "close" || chrome.kind === "outside") {
			this.#onCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "close") {
			this.#browser.handleCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#browser.handleInput("\n");
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "refresh") {
			this.#refreshCatalog();
			return true;
		}
		const line = event.row - this.#browserRowStart;
		if (event.wheel !== null || event.motion || event.leftClick) {
			this.#browser.routeMouse(event, line);
			this.#tui.requestRender();
			return true;
		}
		return true;
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, termRows);
		const dims = computeModalDims(width, termRows, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(termRows).fill(padding(width));
		}

		const shortcuts = [
			{ label: "up/down models" },
			{ label: "enter use", clickable: true, id: "confirm" },
			{ label: "type to search" },
			{ label: "ctrl+r refresh", clickable: true, id: "refresh" },
			{ label: this.#browser.query.length > 0 ? "esc clear" : "esc close", clickable: true, id: "close" },
		];
		const chrome = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		});
		const listBudget = Math.max(MIN_VISIBLE, chrome.maxBodyRows - 2 - BROWSER_FRAME_ROWS);
		this.#browser.setMaxVisible(listBudget);

		const status = this.#configError
			? theme.fg("error", this.#configError)
			: theme.fg("muted", this.#refreshing ? REFRESHING_HINT : STATUS_HINT);

		const hint = REFRESH_HINT.length <= dims.contentWidth ? REFRESH_HINT : REFRESH_HINT_SHORT;
		const body = [
			status,
			...this.#browser.render(dims.contentWidth),
			theme.fg("muted", truncateToWidth(hint, dims.contentWidth)),
		];
		const shell = renderModalShell({
			title: "Switch Model",
			sizing,
			areaWidth: width,
			areaHeight: termRows,
			body,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#browserRowStart = (shell.geometry?.bodyRowStart ?? 0) + 1;
		return shell.lines;
	}
}

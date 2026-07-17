/**
 * Compact session-model picker (alt+p / `/switch`): a floating ModalShell
 * hosting just a {@link ModelBrowser} — no provider sidebar.
 * Model entries switch the current session only.
 */
import type { Model } from "@veyyon/pi-ai";
import { type Component, padding, routeSgrMouseInput, type SgrMouseEvent, type TUI } from "@veyyon/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	renderModalShell,
	withCompact,
} from "./modal-shell";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";

export interface ModelPickerCallbacks {
	/** A model was chosen for a session-only switch. `selector` is `provider/id`. */
	onPick: (model: Model, selector: string) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are disabled. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
}

/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;

const STATUS_HINT = "Interactive model — role / subagent / compaction slots stay unchanged";

/**
 * The alt+p picker. Hosted fullscreen; ModalShell paints a floating medium card
 * with clear underpaint so the transcript stays visible around it.
 */
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
	#hoveredShortcutId: string | null = null;
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

		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	invalidate(): void {}

	#syncFromRegistryState(): void {
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			try {
				models = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				models = [];
			}
		}

		const allModels = this.#scopedModels.length > 0 ? models : this.#registry.getAll();
		const roles = resolveRoleAssignments(this.#settings, allModels, models);
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
		this.#browser.handleInput(data);
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.#tui.requestRender();
			}
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.#onCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#browser.handleInput("\n");
			return true;
		}
		return true;
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const sizing = withCompact(MODAL_SIZING_MEDIUM, termRows < 24);
		const dims = computeModalDims(width, termRows, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: termRows }, () => padding(width));
		}

		const listBudget = Math.max(MIN_VISIBLE, dims.modalHeight - 8 - BROWSER_FRAME_ROWS);
		this.#browser.setMaxVisible(listBudget);

		const status = this.#configError ? theme.fg("error", this.#configError) : theme.fg("muted", STATUS_HINT);

		const body = [status, ...this.#browser.render(dims.contentWidth)];
		const shell = renderModalShell({
			title: "Switch Model",
			sizing,
			areaWidth: width,
			areaHeight: termRows,
			body,
			shortcuts: [
				{ label: "up/down models" },
				{ label: "enter use", clickable: true, id: "confirm" },
				{ label: "type to search" },
				{ label: "esc close", clickable: true, id: "close" },
			],
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}
}

/**
 * Compact session-model picker (alt+p / `/switch`): a floating ModalShell
 * hosting just a {@link ModelBrowser} — no provider sidebar.
 * Model entries switch the current session only.
 */
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
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
	planModalChrome,
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
	/**
	 * Play the open unfold (TOUCH-5). Opt-in at the real show site only: the
	 * reveal is wall-clock-driven, so a default-on would make every direct
	 * construction (tests, embedders) render mid-animation frames.
	 */
	reveal?: boolean;
}

/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;

const STATUS_HINT = "Interactive model — role / subagent / compaction slots stay unchanged";
/**
 * The list is only ever as new as the cached catalog. Opening the picker calls
 * `refresh("online-if-uncached")`, which answers from a cache that stays fresh
 * for two hours, so a model a provider shipped this morning is simply absent
 * with nothing on screen saying why. This names the way to look again.
 *
 * The medium card is narrow, and truncating this mid-word ("…from yo…") loses
 * the only part that matters, so it degrades to a shorter whole sentence
 * rather than a clipped long one. The key is in both, since that is the
 * actionable half.
 */
const REFRESH_HINT = "Don't see a model? ctrl+r reloads the catalog from your providers and models.dev";
const REFRESH_HINT_SHORT = "Don't see a model? ctrl+r reloads the catalog";
const REFRESHING_HINT = "Reloading the model catalog…";

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
	/** Frame row where the browser's first rendered row (its search row) sits. */
	#browserRowStart = 0;
	#hoveredShortcutId: string | null = null;
	#refreshing = false;
	#onCancel: () => void;
	/** One-shot open unfold (TOUCH-5); settles instantly with shimmer disabled. */
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

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

		// The show site decides availability (modalRevealEnabled); a truthy
		// option here always animates, keeping direct constructions deterministic.
		if (options.reveal) {
			this.#reveal.start(() => this.#tui.requestRender());
		}

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
					this.#configError = errorMessage(error);
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
		// Ahead of the browser, which takes every key it does not claim as query text.
		if (matchesKey(data, "ctrl+r")) {
			this.#refreshCatalog();
			return;
		}
		this.#browser.handleInput(data);
	}

	/**
	 * Re-fetch every provider past the cache TTL. This is the only strategy that
	 * ignores a fresh cache, so it is the difference between "the catalog I was
	 * handed at startup" and "what the providers and models.dev serve now".
	 */
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
			// The [x] and an outside click are hard closes regardless of query.
			this.#onCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "close") {
			// The esc chip performs exactly what its label promises: the same
			// cancel ladder as the esc key (clear a live query, then close).
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
		// The body is [status, ...browser, hint]: the browser owns the rows
		// between the status line and the trailing hint.
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
			return Array.from({ length: termRows }, () => padding(width));
		}

		const shortcuts = [
			{ label: "up/down models" },
			{ label: "enter use", clickable: true, id: "confirm" },
			{ label: "type to search" },
			{ label: "ctrl+r refresh", clickable: true, id: "refresh" },
			// The esc chip mirrors the browser's cancel ladder: with a live
			// query esc clears the search (close comes on the next press), so
			// the chip must not advertise "close" it will not perform.
			{ label: this.#browser.query.length > 0 ? "esc clear" : "esc close", clickable: true, id: "close" },
		];
		// The body is the status line, the browser, and the refresh hint, so the
		// list gets whatever the card shows minus those. The old `- 8` was right
		// only by accident: the shell reserves 7 at this sizing and the status
		// line was the eighth, three unnamed rows that happened to add up. Change
		// `vPad`, `footerLines`, either bracketing line, or the browser frame and
		// it silently starts dropping the bottom of the list.
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
		// The body leads with the status line; the browser starts one row later.
		this.#browserRowStart = (shell.geometry?.bodyRowStart ?? 0) + 1;
		return applyModalReveal(shell, width, this.#reveal.value);
	}
}

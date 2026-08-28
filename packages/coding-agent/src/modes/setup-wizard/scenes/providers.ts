import { type SgrMouseEvent, TabBar } from "@veyyon/tui";
import { getTabBarTheme } from "../../shared";
import { SignInTab } from "./sign-in";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost, SetupTab } from "./types";
import { WebSearchTab } from "./web-search";

/** Tabbed "Set up your providers" scene. Composes independent panels (model sign-in, web search) behind a {@link TabBar}; the active panel owns */
class ProvidersSceneController implements SetupSceneController {
	title = "Set up your providers";
	subtitle = "Connect at least one account. Tab switches panels; Enter confirms a row.";

	#tabs: SetupTab[];
	#tabBar: TabBar;
	/** Lines the tab bar occupied in the last render (body starts one blank line below). */
	#tabRowCount = 1;

	constructor(host: SetupSceneHost) {
		this.#tabs = [new SignInTab(host), new WebSearchTab(host)];
		this.#tabBar = new TabBar(
			"Providers",
			this.#tabs.map(tab => ({ id: tab.id, label: tab.label })),
			getTabBarTheme(),
		);
		// No "(tab to cycle)" hint: the wizard footer names tab switching for whichever scene is on screen, and carrying it in both places states the
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			this.#activeTab().onActivate?.();
			host.requestRender();
		};
	}

	#activeTab(): SetupTab {
		return this.#tabs[this.#tabBar.getActiveIndex()] ?? this.#tabs[0];
	}

	onMount(): void {
		this.#activeTab().onActivate?.();
	}

	invalidate(): void {
		for (const tab of this.#tabs) tab.invalidate();
	}

	/** Tab is the key users could not find: this scene's panels are reachable only through the tab bar, and the footer never said so. While a panel is */
	keyHints(): readonly SetupKeyHint[] {
		const hints: SetupKeyHint[] = [];
		if (!this.#activeTab().modal) hints.push({ keys: "tab", label: "switch panel" });
		hints.push({ keys: "↑↓", label: "select" }, { keys: "enter", label: "confirm" });
		return hints;
	}

	/** Esc belongs to whichever panel is on screen, because only it knows what state it is in: the sign-in panel claims Esc to abort a login in flight or */
	escapeAction(): SetupKeyHint | undefined {
		return this.#activeTab().escapeAction?.();
	}

	handleInput(data: string): void {
		const tab = this.#activeTab();
		if (tab.modal) {
			tab.handleInput(data);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		tab.handleInput(data);
	}

	/** Hit-test mouse reports against the last render: rows inside the tab bar hover/switch tabs (suppressed while the active panel is modal, matching */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const tab = this.#activeTab();
		if (event.wheel === null && line >= 0 && line < this.#tabRowCount) {
			if (tab.modal) return;
			const hit = this.#tabBar.tabAt(line, col);
			if (event.motion) {
				this.#tabBar.setHoverTab(hit && !hit.muted ? hit.id : null);
			} else if (event.leftClick && hit) {
				this.#tabBar.selectTab(hit.id);
			}
			return;
		}
		if (event.motion) this.#tabBar.setHoverTab(null);
		const spacerRowsAfterTabs = 1;
		const bodyLine = line - this.#tabRowCount - spacerRowsAfterTabs;
		if (tab.routeMouse) {
			tab.routeMouse(event, bodyLine, col);
			return;
		}
		if (event.wheel !== null && !tab.modal) {
			tab.handleInput(event.wheel === -1 ? "\x1b[A" : "\x1b[B");
		}
	}

	render(width: number, rows?: number): readonly string[] {
		const tabLines = this.#tabBar.render(width);
		this.#tabRowCount = tabLines.length;
		const spacerRows = 1;
		const panelRows = rows === undefined ? undefined : Math.max(1, rows - tabLines.length - spacerRows);
		return tabLines.concat([""], this.#activeTab().render(width, panelRows));
	}

	dispose(): void {
		for (const tab of this.#tabs) tab.dispose();
	}
}

export const providersSetupScene: SetupScene = {
	id: "providers",
	stepLabel: "Providers",
	title: "Set up your providers",
	minVersion: 1,
	mount: host => new ProvidersSceneController(host),
};

import type { Component, SgrMouseEvent } from "@veyyon/tui";
import type { InteractiveModeContext } from "../../types";

export type SetupWizardContext = Pick<
	InteractiveModeContext,
	"openInBrowser" | "session" | "settings" | "showError" | "ui"
>;

export type SetupSceneResult = "done" | "skipped";

export interface SetupSceneHost {
	ctx: SetupWizardContext;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	skipSetup(): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

export interface SetupKeyHint {
	readonly keys: string;
	readonly label: string;
}

export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	render(width: number, rows?: number): readonly string[];
	onMount?(): void | Promise<void>;
	onUnmount?(): void | Promise<void>;
	dispose?(): void;
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	keyHints?(): readonly SetupKeyHint[];
	escapeAction?(): SetupKeyHint | undefined;
}

export interface SetupTab {
	readonly id: string;
	readonly label: string;
	readonly modal: boolean;
	render(width: number, rows?: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	escapeAction?(): SetupKeyHint | undefined;
	onActivate?(): void;
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

export interface SetupScene {
	id: string;
	title: string;
	stepLabel?: string;
	minVersion: number;
	shouldRun?(ctx: SetupWizardContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}

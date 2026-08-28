import type { Component, SgrMouseEvent } from "@veyyon/tui";
import type { InteractiveModeContext } from "../../types";

/** The slice of the interactive context the setup wizard and its scenes use. Declared once here and shared by the wizard entry point, its lazy loader, the */
export type SetupWizardContext = Pick<
	InteractiveModeContext,
	"openInBrowser" | "session" | "settings" | "showError" | "ui"
>;

export type SetupSceneResult = "done" | "skipped";

export interface SetupSceneHost {
	ctx: SetupWizardContext;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	/** Exit the entire onboarding run without applying any in-progress text entry. */
	skipSetup(): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

/** One footer hint: a key as the user presses it, and what that key does. The wizard footer is assembled from these instead of being one fixed string, */
export interface SetupKeyHint {
	/** The key as pressed, lower case, e.g. `tab` or `↑↓`. */
	readonly keys: string;
	/** What it does, lower case and short, e.g. `switch panel`. */
	readonly label: string;
}

export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	/** Render the scene body. `rows` is the number of terminal rows the wizard has left for this body */
	render(width: number, rows?: number): readonly string[];
	onMount?(): void | Promise<void>;
	/** Called when the scene leaves the screen for ANY reason: Esc, ctrl+c, `→`, `←`, or the wizard being disposed. A scene that applied anything to the */
	onUnmount?(): void | Promise<void>;
	dispose?(): void;
	/** Route an SGR mouse report (tracking is on while the wizard holds the alternate screen). `line`/`col` are 0-based within this controller's */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	/** The keys that act INSIDE this scene, for the wizard footer. Omit it to get the default select/confirm pair. Do NOT include the keys that move the */
	keyHints?(): readonly SetupKeyHint[];
	/** What Esc means inside this scene RIGHT NOW, or `undefined` to let the wizard's Esc (leave setup) win. */
	escapeAction?(): SetupKeyHint | undefined;
}

/** A single panel inside a tabbed setup scene. The host scene owns the tab bar and forwards rendering/input to the active tab. */
export interface SetupTab {
	readonly id: string;
	readonly label: string;
	/** While `true` the tab owns all keyboard input (e.g. an in-progress OAuth login). The parent scene MUST NOT switch tabs or finish while modal. */
	readonly modal: boolean;
	/** See {@link SetupSceneController.render}: `rows` is the panel's row budget. */
	render(width: number, rows?: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	/** What Esc means inside this panel RIGHT NOW; see {@link SetupSceneController.escapeAction}, whose contract this is. */
	escapeAction?(): SetupKeyHint | undefined;
	/** Called when the tab becomes active (including initial mount). */
	onActivate?(): void;
	/** Mouse routing at tab-local coordinates; see {@link SetupSceneController.routeMouse}. */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

export interface SetupScene {
	id: string;
	title: string;
	/** One or two words naming this step in the wizard's progress breadcrumb. Separate from {@link title}, which is a sentence addressed to the user */
	stepLabel?: string;
	/** The onboarding generation this scene was introduced in. It is a floor, not a per-scene trigger: a scene runs whenever its floor is at or below the current */
	minVersion: number;
	shouldRun?(ctx: SetupWizardContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}

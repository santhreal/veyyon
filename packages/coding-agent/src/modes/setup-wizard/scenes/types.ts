import type { Component, SgrMouseEvent } from "@veyyon/tui";
import type { InteractiveModeContext } from "../../types";

/**
 * The slice of the interactive context the setup wizard and its scenes use.
 *
 * Declared once here and shared by the wizard entry point, its lazy loader, the
 * overlay, and every scene, so all of them agree on what the wizard is allowed
 * to touch. Six members of 215; see `CollabHostContext` for why the full
 * interface is not usable as a parameter type.
 */
export type SetupWizardContext = Pick<
	InteractiveModeContext,
	"openInBrowser" | "playWelcomeIntro" | "session" | "settings" | "showError" | "ui"
>;

export type SetupSceneResult = "done" | "skipped";

export interface SetupSceneHost {
	ctx: SetupWizardContext;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	onMount?(): void | Promise<void>;
	onUnmount?(): void;
	dispose?(): void;
	/**
	 * Route an SGR mouse report (tracking is on while the wizard holds the
	 * alternate screen). `line`/`col` are 0-based within this controller's
	 * last rendered output. When absent, the wizard falls back to synthesizing
	 * arrow keys from wheel notches.
	 */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
}

/**
 * A single panel inside a tabbed setup scene. The host scene owns the tab bar
 * and forwards rendering/input to the active tab.
 */
export interface SetupTab {
	readonly id: string;
	readonly label: string;
	/**
	 * While `true` the tab owns all keyboard input (e.g. an in-progress OAuth
	 * login). The parent scene MUST NOT switch tabs or finish while modal.
	 */
	readonly modal: boolean;
	render(width: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	/** Called when the tab becomes active (including initial mount). */
	onActivate?(): void;
	/** Mouse routing at tab-local coordinates; see {@link SetupSceneController.routeMouse}. */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

export interface SetupScene {
	id: string;
	title: string;
	/**
	 * The onboarding generation this scene was introduced in. It is a floor, not a
	 * per-scene trigger: a scene runs whenever its floor is at or below the current
	 * generation ({@link CURRENT_SETUP_VERSION}, see `selectSetupScenes`). Since the
	 * gate is fixed, all shipped scenes use the current generation; a scene can be
	 * staged for a future generation by setting this ahead of it.
	 */
	minVersion: number;
	shouldRun?(ctx: SetupWizardContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}

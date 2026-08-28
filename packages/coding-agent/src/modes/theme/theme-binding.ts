import type { Theme } from "./theme-class";

/** The live binding for the active theme. `applyTheme` and friends reassign, and importers see the reassignment because */
export var theme: Theme;

/** Publish a newly loaded theme to every reader. The engine calls this instead of assigning `theme` directly, because a module */
export function setActiveTheme(next: Theme): void {
	theme = next;
}

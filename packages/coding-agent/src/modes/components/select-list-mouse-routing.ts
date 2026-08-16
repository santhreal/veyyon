import type { Component, SelectList, SgrMouseEvent } from "@veyyon/tui";
import { Container, routeSelectListMouse } from "@veyyon/tui";

interface RoutableSelectList {
	routeMouse?: (event: SgrMouseEvent, line: number, col: number) => void;
	handleWheel(delta: -1 | 1): void;
	hitTest(line: number): number | undefined;
	setHoverIndex(index: number | null): void;
	clickItem(index: number): void;
}

/**
 * Render a Container's children exactly like Container.render (plain
 * concatenation), recording the 0-based line `tracked` starts at. Pair with
 * {@link routeTrackedMouse}: the offset is meaningless without the route and
 * the route is wrong without the offset, so the two are one pattern with one
 * owner — a submenu that re-implements either half by hand is how mouse
 * support silently breaks on one screen while working everywhere else.
 *
 * The memoized Container.render cannot report the offset, so this pays one
 * child-render walk per frame; submenu bodies are a dozen rows, never the
 * transcript, and the trade is deliberate.
 */
export function renderTrackingChild(
	container: Container,
	tracked: Component | undefined,
	width: number,
): { lines: string[]; trackedLineOffset: number } {
	const lines: string[] = [];
	let trackedLineOffset = 0;
	for (const child of container.children) {
		const childLines = child.render(Math.max(1, width));
		if (child === tracked) trackedLineOffset = lines.length;
		lines.push(...childLines);
	}
	return { lines, trackedLineOffset };
}

/**
 * Route a mouse event to the interactive child {@link renderTrackingChild}
 * tracked: a SelectList gets wheel/hover/click via the shared
 * {@link routeSelectListMouse}, any other MouseRoutable child gets the event
 * forwarded at its own offset. Undefined target (a state with nothing
 * interactive, e.g. a text input) consumes the event silently, matching the
 * settings-list contract for submenus without a route.
 */
export function routeTrackedMouse(
	target:
		| SelectList
		| (Component & { routeMouse?: (event: SgrMouseEvent, line: number, col: number) => void })
		| undefined,
	event: SgrMouseEvent,
	line: number,
	trackedLineOffset: number,
	col: number,
): void {
	if (!target) return;
	const localLine = line - trackedLineOffset;
	if ("hitTest" in target && "clickItem" in target) {
		routeSelectListMouse(target as SelectList, event, localLine);
		return;
	}
	target.routeMouse?.(event, localLine, col);
}

/** The interactive child a {@link MouseRoutedSubmenu} can point at. */
export type TrackedMouseTarget =
	| SelectList
	| (Component & { routeMouse?: (event: SgrMouseEvent, line: number, col: number) => void });

/**
 * Base for settings submenus whose interactive child is a SelectList or a
 * MouseRoutable panel: render records where that child lands, routeMouse
 * forwards at the recorded offset. The subclass supplies only `mouseTarget()`;
 * the offset/route pair itself lives here once, so no submenu can grow a
 * second spelling that drifts off the host's coordinates.
 */
export abstract class MouseRoutedSubmenu extends Container {
	#mouseTargetLineOffset = 0;

	/** The child pointer events belong to in the current state, or undefined. */
	abstract mouseTarget(): TrackedMouseTarget | undefined;

	override render(width: number): readonly string[] {
		const { lines, trackedLineOffset } = renderTrackingChild(this, this.mouseTarget(), width);
		this.#mouseTargetLineOffset = trackedLineOffset;
		return lines;
	}

	/** Mouse routed from the host: wheel steps, hover lights, click confirms. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeTrackedMouse(this.mouseTarget(), event, line, this.#mouseTargetLineOffset, col);
	}
}

export function routeSelectListMouseWithTopBorder(
	selectList: SelectList,
	event: SgrMouseEvent,
	line: number,
	col: number,
): void {
	const localLine = line - 1;
	const target = selectList as RoutableSelectList;
	if (typeof target.routeMouse === "function") {
		target.routeMouse(event, localLine, col);
		return;
	}
	if (event.wheel !== null) {
		target.handleWheel(event.wheel);
		return;
	}
	const index = target.hitTest(localLine);
	if (event.motion) {
		target.setHoverIndex(index ?? null);
		return;
	}
	if (event.leftClick && index !== undefined) {
		target.clickItem(index);
	}
}

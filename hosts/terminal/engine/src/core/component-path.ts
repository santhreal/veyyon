/**
 * Paths through the component tree: the chain from a root down to one descendant, and whether a chain
 * found on an earlier paint still holds. The root keeps a scoped frame's chain between paints with these.
 */
import type { Component } from "./component-types";
import type { Container } from "./container";

/**
 * The chain of components from `root` down to `target`, both included, or null when
 * `target` is not in `root`'s `Container`-shaped subtree.
 *
 * Children are searched newest first. The component asking for a scoped frame is
 * nearly always a spinner or a streaming block at the tail of a transcript, and an
 * oldest-first search visited every block of a long session's history to reach it:
 * a 58,000-turn transcript spent 94% of an idle process's CPU here, once per
 * animation frame.
 */
export function pathToDescendant(root: Component, target: Component): Component[] | null {
	if (root === target) return [root];
	const children = (root as Partial<Container>).children;
	if (!Array.isArray(children)) return null;
	for (let i = children.length - 1; i >= 0; i--) {
		const path = pathToDescendant(children[i]!, target);
		if (path !== null) {
			path.unshift(root);
			return path;
		}
	}
	return null;
}

/**
 * Whether every link of a chain from {@link pathToDescendant} still holds: each
 * component is still a child of the one before it. Exact under any mutation of a
 * `children` array, including a direct one that bypasses `Container` methods, and it
 * costs one membership scan per link instead of a walk of the whole subtree.
 */
export function isPathIntact(path: readonly Component[]): boolean {
	for (let i = 1; i < path.length; i++) {
		const children = (path[i - 1] as Partial<Container>).children;
		if (!Array.isArray(children) || children.lastIndexOf(path[i]!) === -1) return false;
	}
	return true;
}

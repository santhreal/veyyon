/**
 * A component whose render is the concatenation of its children's renders.
 *
 * The memo is the whole reason this is not three lines: children are rendered every frame because a
 * render carries side effects (image placement registration, seam and stability reports), but the
 * concatenated array is rebuilt only when a child returns a different array reference. Per the
 * `Component` render contract that reference is proof the rows are byte-identical, so the engine's
 * stable-prefix reuse survives a container in the middle of the tree.
 */
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import type { Component } from "./component-types";

/**
 * The children's rows in order. A render result is never mutated (the Component render contract), so when one
 * child holds every row its array is the joined render as it stands. A streaming message body beside empty slots
 * is that shape, and copying its rows walked the whole block on every frame.
 */
function joinChildRows(refs: readonly (readonly string[])[]): readonly string[] {
	let sole = -1;
	for (let i = 0; i < refs.length; i++) {
		if (refs[i]!.length === 0) continue;
		if (sole !== -1) {
			sole = -2;
			break;
		}
		sole = i;
	}
	if (sole >= 0) return refs[sole]!;
	const joined: string[] = [];
	for (let i = 0; i < refs.length; i++) {
		const childLines = refs[i]!;
		for (let j = 0; j < childLines.length; j++) joined.push(childLines[j]!);
	}
	return joined;
}

export class Container implements Component, MouseRoutable {
	children: Component[] = [];

	// Memoized concatenation of the children's latest renders. Children are
	// still rendered every frame (renders carry side effects: image placement
	// registration, seam/stability reports); the memo only skips rebuilding
	// the concatenated array when every child returned the exact same array
	// reference at the same width — which, per the Component render contract,
	// proves the rows are byte-identical. Cleared on any child-list change and
	// on invalidate().
	#memoLines: readonly string[] | undefined;
	#memoChildLines: (readonly string[])[] = [];
	#memoWidth = -1;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		for (const child of this.children) {
			child.setIgnoreTight?.(ignore);
		}
		this.invalidate();
		return this;
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#memoLines = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#memoLines = undefined;
		}
	}

	clear(): void {
		this.children = [];
		this.#memoLines = undefined;
		this.#memoChildLines = [];
	}

	/** Dispose every child, then detach it from this container. */
	disposeChildren(): void {
		this.dispose();
		this.clear();
	}

	invalidate(): void {
		this.#memoLines = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	releaseRenderCache(): void {
		this.#memoLines = undefined;
		this.#memoChildLines = [];
		this.#memoWidth = -1;
		for (const child of this.children) {
			child.releaseRenderCache?.();
		}
	}

	/**
	 * Propagate teardown to children. Call when the container's children are
	 * being permanently discarded (not when they are detached for reuse — use
	 * {@link clear} for that). Idempotent per child via each child's own dispose.
	 */
	dispose(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const unchanged = this.#renderChildren(width);
		this.#memoWidth = width;
		if (unchanged) return this.#memoLines!;
		const lines = joinChildRows(this.#memoChildLines);
		this.#memoLines = lines;
		return lines;
	}

	/**
	 * Render every child at `width` into the per-child memo. True when the joined memo is valid at this
	 * width and every child returned the array it returned last frame.
	 */
	#renderChildren(width: number): boolean {
		const children = this.children;
		const count = children.length;
		let refs = this.#memoChildLines;
		let unchanged = this.#memoLines !== undefined && this.#memoWidth === width && refs.length === count;
		if (refs.length !== count) {
			refs = new Array(count);
			this.#memoChildLines = refs;
		}
		for (let i = 0; i < count; i++) {
			const childLines = children[i]!.render(width);
			if (refs[i] !== childLines) {
				unchanged = false;
				refs[i] = childLines;
			}
		}
		return unchanged;
	}

	/**
	 * Hand a pointer event to the child under `line`, in that child's own rows.
	 *
	 * A pinned-footer click is routed to a ROOT child (see `#routeFooterMouse`),
	 * and the composer zone mounts its editor inside a container, so without this
	 * the event stopped at the container and nothing below it could own a click
	 * target. Row spans come from the last render's memoized child lines, so this
	 * costs nothing per frame; a container that has not rendered since its child
	 * list changed has no trustworthy geometry and drops the event rather than
	 * routing to the wrong child.
	 */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const children = this.children;
		const refs = this.#memoChildLines;
		if (refs.length !== children.length) return;
		let start = 0;
		for (let i = 0; i < children.length; i++) {
			const rows = refs[i]?.length ?? 0;
			if (line < start + rows) {
				const child = children[i] as Component & Partial<MouseRoutable>;
				child.routeMouse?.(event, line - start, col);
				return;
			}
			start += rows;
		}
	}
}

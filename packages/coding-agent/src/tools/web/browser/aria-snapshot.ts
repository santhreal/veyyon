import type { ElementHandle, Frame, JSHandle, Page } from "puppeteer-core";
import ariaBundle from "./aria-snapshot.bundle.txt" with { type: "text" };
import { releaseHandle } from "./handle-release";
// `aria-snapshot.bundle.txt` is a generated, committed artifact: Playwright's
// injected ARIA-snapshot sources (pinned, Apache-2.0) bundled to a CJS module.
// The upstream sources are NOT vendored — regenerate the bundle with:
//   bun scripts/generate-aria-snapshot.ts
// (fetches the pinned tag, bundles in a temp dir, rewrites the .txt artifact.)

export interface AriaSnapshotOptions {
	/** Maximum tree depth to render. */
	depth?: number;
	/** Append `[box=x,y,w,h]` bounding boxes to each node. */
	boxes?: boolean;
}

/**
 * Page-side evaluators built ONCE here in the worker — never inside the page, so
 * page CSP never applies. They run the generated Playwright ARIA-snapshot bundle
 * (CJS, see scripts/generate-aria-snapshot.ts) in a throwaway module scope.
 *
 * Puppeteer serializes these functions to a CDP `Runtime.evaluate` in the page's
 * MAIN world (the only world where the bundle's `_ariaRef` ref expandos live —
 * isolated-world locators/query-handlers cannot see them). Nothing is installed
 * on `window`; the only footprint is the `_ariaRef` markers the snapshot writes,
 * which are the price of actionable `[ref=eN]` ids.
 */
function buildEvaluator(params: string, call: string): (...args: unknown[]) => unknown {
	return new Function(
		...params.split(",").map(p => p.trim()),
		`var module = { exports: {} };\n${ariaBundle}\nreturn module.exports.${call};`,
	) as unknown as (...args: unknown[]) => unknown;
}

// Handles (root) must stay top-level args: Puppeteer only unwraps JSHandles
// passed positionally to page.evaluate, never ones nested inside an object.
const evaluateAriaSnapshot = buildEvaluator("root, request", "ariaSnapshot(root, request)");
const evaluateResolveRef = buildEvaluator("ref", "resolveAriaRef(ref)");

/** A snapshot's text and the frames its frame refs point into. */
export interface AriaCapture {
	readonly text: string;
	/** `f1` for the frame whose refs read `f1e…`, one per iframe the snapshot followed. */
	readonly frames: ReadonlyMap<string, Frame>;
}

/** How many iframes deep a snapshot follows. */
const FRAME_DEPTH_MAX = 3;

/** An iframe's line of a snapshot: its indent and its ref. */
const IFRAME_LINE = /^(\s*)- iframe\b.*\[ref=((?:f\d+)?e\d+)\]/;

/**
 * Capture a Playwright-format ARIA snapshot of `root` (or the whole document when
 * null). Always runs in `ai` mode so every node carries a `[ref=eN]` id; resolve
 * those to elements with {@link resolveAriaRefHandle}. Ids are renumbered from e1
 * on each call and remain valid until the next snapshot. Bare `generic` wrappers
 * are left out ({@link withoutBareWrappers}).
 *
 * An iframe's content, same-origin or not, is snapshotted in its own frame and
 * nested under the iframe's line, its refs prefixed with the frame (`f1e3`), up to
 * {@link FRAME_DEPTH_MAX} frames deep, so an element in a payment or sign-in frame
 * is read and acted on like any other.
 */
export async function captureAriaSnapshot(
	page: Page,
	root: ElementHandle | null,
	options: AriaSnapshotOptions = {},
): Promise<AriaCapture> {
	const frames = new Map<string, Frame>();
	const text = await snapshotFrame(page.mainFrame(), root, "", options, frames, FRAME_DEPTH_MAX);
	return { text, frames };
}

async function snapshotFrame(
	frame: Frame,
	root: ElementHandle | null,
	refPrefix: string,
	options: AriaSnapshotOptions,
	frames: Map<string, Frame>,
	depthLeft: number,
): Promise<string> {
	const request = { depth: options.depth, boxes: options.boxes, refPrefix };
	const yaml = withoutBareWrappers(
		(await frame.evaluate(evaluateAriaSnapshot as never, root as never, request as never)) as string,
	);
	if (depthLeft === 0 || !yaml.includes("- iframe")) return yaml;
	const lines: string[] = [];
	for (const line of yaml.split("\n")) {
		lines.push(line);
		const iframe = IFRAME_LINE.exec(line);
		if (!iframe) continue;
		const child = await contentFrameOf(frame, iframe[2] ?? "");
		if (!child) continue;
		const prefix = `f${frames.size + 1}`;
		frames.set(prefix, child);
		// A frame that navigates or goes away while it is read keeps its line and loses its content.
		const inner = await snapshotFrame(child, null, prefix, options, frames, depthLeft - 1).catch(() => "");
		if (inner.trim() === "") continue;
		if (!line.endsWith(":")) lines[lines.length - 1] = `${line}:`;
		for (const innerLine of inner.split("\n")) if (innerLine.trim() !== "") lines.push(`${iframe[1]}  ${innerLine}`);
	}
	return lines.join("\n");
}

/** The document inside the iframe `ref` names in `frame`, or null when it has none. */
async function contentFrameOf(frame: Frame, ref: string): Promise<Frame | null> {
	const handle = (await frame
		.evaluateHandle(evaluateResolveRef as never, ref as never)
		.catch(() => null)) as JSHandle | null;
	if (!handle) return null;
	try {
		const element = handle.asElement();
		return element ? await (element as ElementHandle).contentFrame() : null;
	} finally {
		await releaseHandle(handle);
	}
}

/** A `generic` node with no name, no text, no state and no pointer: a layout `<div>` and nothing else. */
const BARE_WRAPPER = /^\s*- generic \[ref=(?:f\d+)?e\d+\]:$/;

/**
 * The snapshot without its bare `generic` wrappers, each one's children lifted a level into its
 * place. Layout `<div>`s are 7–30% of a real page's snapshot and hold nothing a model reads or acts
 * on; a generic that has a name, text, `[active]`, `[cursor=pointer]` or a box stays. Every other
 * line, and every ref on it, is unchanged.
 */
export function withoutBareWrappers(yaml: string): string {
	const kept: string[] = [];
	// Indents of the dropped wrappers whose children are still being read.
	const lifted: number[] = [];
	for (const line of yaml.split("\n")) {
		const indent = line.length - line.trimStart().length;
		while (lifted.length > 0 && indent <= lifted[lifted.length - 1]!) lifted.pop();
		if (BARE_WRAPPER.test(line)) {
			lifted.push(indent);
			continue;
		}
		kept.push(lifted.length === 0 ? line : line.slice(2 * lifted.length));
	}
	return kept.join("\n");
}

/** A ref in a frame's part of a snapshot: the frame's prefix, then the element's id. */
const FRAME_REF = /^(f\d+)e\d+$/;

/**
 * Resolve a `[ref=eN]` id from the latest snapshot to a live `ElementHandle`, or
 * null when the ref no longer matches any element. A frame ref (`f1e3`) resolves in
 * the frame `frames` names for its prefix, and to null once that frame is gone.
 * Runs in the main world so it sees the `_ariaRef` expandos the snapshot wrote.
 */
export async function resolveAriaRefHandle(
	page: Page,
	ref: string,
	frames: ReadonlyMap<string, Frame> = new Map(),
): Promise<ElementHandle | null> {
	const framePrefix = FRAME_REF.exec(ref)?.[1];
	const frame = framePrefix === undefined ? page.mainFrame() : frames.get(framePrefix);
	if (!frame || frame.detached) return null;
	const handle = (await frame
		.evaluateHandle(evaluateResolveRef as never, ref as never)
		.catch(() => null)) as JSHandle | null;
	if (!handle) return null;
	const element = handle.asElement();
	if (!element) {
		await releaseHandle(handle);
		return null;
	}
	return element as ElementHandle;
}

const ARIA_REF_PREFIXES = ["aria-ref=", "aria-ref/", "ariaref/"];

/**
 * Recognize the explicit `[ref=eN]` selector forms and return the bare ref id,
 * else null. Accepts `aria-ref=e5` (Playwright-MCP style), `aria-ref/e5`, and
 * `ariaref/e5` — lets `tab.click("aria-ref=e5")` etc. act on snapshot refs. A
 * bare `e5` is intentionally NOT a ref selector: the cmux backend already uses
 * bare `eN`/`@eN` for its own observe ids, so requiring the prefix keeps action
 * selectors meaning the same thing on both backends. (`tab.ref("e5")` still
 * accepts a bare id directly.)
 */
export function parseAriaRefSelector(selector: string): string | null {
	const trimmed = selector.trim();
	for (const prefix of ARIA_REF_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			const id = trimmed.slice(prefix.length).trim();
			return /^(?:f\d+)?e\d+$/.test(id) ? id : null;
		}
	}
	return null;
}

/**
 * Build a self-contained expression script that runs the vendored bundle in the
 * page and returns the ARIA snapshot YAML. Used by the cmux backend, whose
 * `browser.eval` RPC takes a script string and returns the completion value (it
 * has no ElementHandle to pass in). The script resolves `selector` via
 * `document.querySelector` in-page (CSS selectors only) or falls back to the
 * whole document. Like the puppeteer path it installs nothing on `window`.
 */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	const request = { depth: options.depth, boxes: options.boxes };
	const sel = selector ? JSON.stringify(selector) : "null";
	return `(function(){var module={exports:{}};\n${ariaBundle}\nvar __sel=${sel};var __root=__sel?document.querySelector(__sel):null;if(__sel&&!__root)throw new Error("tab.ariaSnapshot: selector "+__sel+" matched no element");return module.exports.ariaSnapshot(__root,${JSON.stringify(request)});})()`;
}

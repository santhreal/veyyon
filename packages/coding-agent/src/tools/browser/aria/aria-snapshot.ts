import type { ElementHandle, JSHandle, Page } from "puppeteer-core";
import { releaseHandle } from "../handle-release";
import ariaBundle from "./aria-snapshot.bundle.txt" with { type: "text" };
// `aria-snapshot.bundle.txt` is a generated, committed artifact: Playwright's injected ARIA-snapshot sources (pinned, Apache-2.0) bundled to a CJS module.

export interface AriaSnapshotOptions {
	/** Maximum tree depth to render. */
	depth?: number;
	/** Append `[box=x,y,w,h]` bounding boxes to each node. */
	boxes?: boolean;
}

/** Page-side evaluators built ONCE here in the worker — never inside the page, so page CSP never applies. They run the generated Playwright ARIA-snapshot bundle */
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

/** Capture a Playwright-format ARIA snapshot of `root` (or the whole document when null). Always runs in `ai` mode so every node carries a `[ref=eN]` id; resolve */
export async function captureAriaSnapshot(
	page: Page,
	root: ElementHandle | null,
	options: AriaSnapshotOptions = {},
): Promise<string> {
	const request = { depth: options.depth, boxes: options.boxes };
	return (await page.evaluate(evaluateAriaSnapshot as never, root as never, request as never)) as string;
}

/** Resolve a `[ref=eN]` id from the latest snapshot to a live `ElementHandle`, or null when the ref no longer matches any element. Runs in the main world so it */
export async function resolveAriaRefHandle(page: Page, ref: string): Promise<ElementHandle | null> {
	const handle = (await page.evaluateHandle(evaluateResolveRef as never, ref as never)) as JSHandle;
	const element = handle.asElement();
	if (!element) {
		await releaseHandle(handle);
		return null;
	}
	return element as ElementHandle;
}

const ARIA_REF_PREFIXES = ["aria-ref=", "aria-ref/", "ariaref/"];

/** Recognize the explicit `[ref=eN]` selector forms and return the bare ref id, else null. Accepts `aria-ref=e5` (Playwright-MCP style), `aria-ref/e5`, and */
export function parseAriaRefSelector(selector: string): string | null {
	const trimmed = selector.trim();
	for (const prefix of ARIA_REF_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			const id = trimmed.slice(prefix.length).trim();
			return /^e\d+$/.test(id) ? id : null;
		}
	}
	return null;
}

/** Build a self-contained expression script that runs the vendored bundle in the page and returns the ARIA snapshot YAML. Used by the cmux backend, whose */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	const request = { depth: options.depth, boxes: options.boxes };
	const sel = selector ? JSON.stringify(selector) : "null";
	return `(function(){var module={exports:{}};\n${ariaBundle}\nvar __sel=${sel};var __root=__sel?document.querySelector(__sel):null;if(__sel&&!__root)throw new Error("tab.ariaSnapshot: selector "+__sel+" matched no element");return module.exports.ariaSnapshot(__root,${JSON.stringify(request)});})()`;
}

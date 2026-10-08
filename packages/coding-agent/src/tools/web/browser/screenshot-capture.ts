import { bestEffort } from "@veyyon/utils/discarded-fault";
import type { CDPSession, ElementHandle, ImageFormat, Page } from "puppeteer-core";
import { ToolError } from "../../core/tool-errors";

/**
 * A `Page.captureScreenshot` sent while the page commits a navigation (a script reload, a
 * redirect, a form post) can wait on a compositor frame that never arrives: Chromium answers it
 * never, and the capture holds until the protocol timeout. A second capture sent on a fresh CDP
 * session answers in tens of milliseconds. Each capture is therefore an attempt that a later one
 * may overtake, and the first to answer wins.
 *
 * The capture goes over its own session and never through `page.screenshot()`: puppeteer holds a
 * per-context screenshot lock for the whole capture, and `page.close()` waits on that lock, so one
 * stalled capture also stalled every later screenshot and the close of the tab that issued it.
 */

/** How long a capture runs before a second one is sent beside it. A healthy capture answers in under 100 ms. */
export const CAPTURE_HEDGE_MS = 1_000;
/** Captures sent for one screenshot, counting the first. */
export const CAPTURE_MAX_ATTEMPTS = 3;

/** The `Page.captureScreenshot` parameters a tab screenshot varies. */
export interface CaptureParams {
	format: ImageFormat;
	captureBeyondViewport: boolean;
	clip?: { x: number; y: number; width: number; height: number; scale: number };
}

/** One capture in flight: its base64 image data, and the release of the session it runs on. */
export interface CaptureAttempt {
	readonly result: Promise<string>;
	release(): void;
}

/**
 * Run `start()` and send another attempt every `hedgeAfterMs` while none has answered, up to
 * `maxAttempts`. A failed attempt is replaced at once when nothing else is in flight. The first
 * answer resolves; every attempt is released when the race settles, which rejects any still in
 * flight. Rejects with the last failure once every attempt failed, or with the signal's reason.
 */
export function hedgeCapture(
	start: () => CaptureAttempt,
	options: { hedgeAfterMs: number; maxAttempts: number; signal?: AbortSignal },
): Promise<string> {
	const { hedgeAfterMs, maxAttempts, signal } = options;
	if (signal?.aborted) return Promise.reject(signal.reason);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const attempts: CaptureAttempt[] = [];
	let inFlight = 0;
	let settled = false;
	let hedge: NodeJS.Timeout | undefined;
	const settle = (): void => {
		settled = true;
		clearTimeout(hedge);
		signal?.removeEventListener("abort", onAbort);
		for (const attempt of attempts) attempt.release();
	};
	const onAbort = (): void => {
		if (settled) return;
		settle();
		reject(signal?.reason);
	};
	const launch = (): void => {
		clearTimeout(hedge);
		const attempt = start();
		attempts.push(attempt);
		inFlight++;
		if (attempts.length < maxAttempts) hedge = setTimeout(launch, hedgeAfterMs);
		attempt.result.then(
			data => {
				if (settled) return;
				settle();
				resolve(data);
			},
			(error: unknown) => {
				inFlight--;
				if (settled || inFlight > 0) return;
				if (attempts.length < maxAttempts) {
					launch();
					return;
				}
				settle();
				reject(error);
			},
		);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	launch();
	return promise;
}

/** Send one `Page.captureScreenshot` for `page` on a session of its own. */
export function startCapture(page: Page, params: CaptureParams): CaptureAttempt {
	let session: CDPSession | undefined;
	let released = false;
	const detach = (opened: CDPSession): Promise<void> =>
		bestEffort(opened.detach(), "a capture session that will not detach belongs to a closing target");
	const result = (async () => {
		const opened = await page.createCDPSession();
		if (released) {
			await detach(opened);
			throw new ToolError("Screenshot capture was released before it was sent");
		}
		session = opened;
		const { data } = await opened.send("Page.captureScreenshot", {
			...params,
			fromSurface: true,
			optimizeForSpeed: false,
		});
		return data;
	})();
	return {
		result,
		release() {
			released = true;
			const opened = session;
			session = undefined;
			if (opened) void detach(opened);
		},
	};
}

/**
 * The page-coordinate clip of `handle` for a capture beyond the viewport: its box in the main
 * frame's viewport, which puppeteer offsets through every enclosing frame, plus the main frame's
 * scroll position.
 */
export async function elementClip(page: Page, handle: ElementHandle): Promise<NonNullable<CaptureParams["clip"]>> {
	const box = await handle.boundingBox();
	if (!box || box.width === 0 || box.height === 0) {
		throw new ToolError("Screenshot selector matched an element with no visible box; it is hidden or empty");
	}
	const session = await page.createCDPSession();
	let pageX: number;
	let pageY: number;
	try {
		({ pageX, pageY } = (await session.send("Page.getLayoutMetrics")).cssVisualViewport);
	} finally {
		await bestEffort(session.detach(), "a metrics session that will not detach belongs to a closing target");
	}
	const x = Math.round(box.x + pageX);
	const y = Math.round(box.y + pageY);
	return {
		x,
		y,
		width: Math.round(box.width + box.x + pageX - x),
		height: Math.round(box.height + box.y + pageY - y),
		scale: 1,
	};
}

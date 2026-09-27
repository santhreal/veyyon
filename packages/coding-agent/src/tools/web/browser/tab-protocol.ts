import type { ImageContent, TextContent } from "@veyyon/ai";
import type { HostIdentity } from "./host-identity";

export type Transferable = Bun.Transferable;

export interface ObservationEntry {
	id: number;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

export interface Observation {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: {
		x: number;
		y: number;
		width: number;
		height: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	elements: ObservationEntry[];
}

export interface ScreenshotResult {
	dest: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
}

export interface SessionSnapshot {
	cwd: string;
	browserScreenshotDir?: string;
	/** Force non-WebP screenshot encoding (e.g. for Ollama). Unset honors `VEYYON_NO_WEBP`. */
	excludeWebP?: boolean;
	/**
	 * `browser.naturalInput` for this run: pointer travel, key-by-key typing and wheel scrolling paced as
	 * a person's when true; instant input otherwise.
	 */
	naturalInput: boolean;
}

/** What a page of a browser this process launched is sent: its identity and its viewport. */
export interface TabPresentation {
	identity?: HostIdentity;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
}

export type WorkerInitPayload =
	| {
			mode: "headless";
			browserWSEndpoint: string;
			viewport?: { width: number; height: number; deviceScaleFactor?: number };
			dialogs?: "accept" | "dismiss";
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
			/** The isolated context to open the page in, by CDP id; the browser's default context when absent. */
			browserContextId?: string;
			/** The host-true identity the browser launched with; the page takes it before its first navigation. */
			identity?: HostIdentity;
	  }
	| {
			mode: "attach";
			browserWSEndpoint: string;
			targetId: string;
			dialogs?: "accept" | "dismiss";
			/**
			 * Post-timeout recycle: before adopting the page, dismiss any open JS dialog and
			 * stop a pending navigation so a blocked target cannot stall worker init (which
			 * previously force-killed the tab). Never set for first-time Electron attach.
			 */
			recover?: boolean;
			/**
			 * Set when the target is a tab of a browser this process launched, re-adopted by a new worker.
			 * The page's identity overrides, scripts and viewport went with the old worker's connection,
			 * which the replacement closed, so the new worker sends them again and drives the tab as a
			 * launched one. Absent for a browser this process attached to.
			 */
			present?: TabPresentation;
	  };
export type ToolReply = { ok: true; value: unknown } | { ok: false; error: TabRunErrorPayload };

export type TabWorkerInbound =
	/** `port`, set for a worker thread, is its browser connection, which the main thread holds and relays. */
	| { type: "init"; payload: WorkerInitPayload; port?: MessagePort }
	| { type: "run"; id: string; name: string; code: string; timeoutMs: number; session: SessionSnapshot }
	| { type: "abort"; id: string; expectedCleanup?: boolean }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

export interface ReadyInfo {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	targetId: string;
}

export interface RunResultOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ScreenshotResult[];
}

export interface TabRunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
}

/**
 * What a run had already produced when it failed.
 *
 * A failing run is exactly the run whose output you need: the `display()` calls and screenshots
 * taken before the throw are the evidence for WHY it threw. The worker used to discard them and
 * report only the error, so a cell that dumped an observation and then timed out came back with a
 * bare "timed out" and nothing to read. There is no `returnValue` here because a run that threw
 * never produced one.
 */
export interface RunResultPartial {
	displays: Array<TextContent | ImageContent>;
	screenshots: ScreenshotResult[];
}

/** An error from a failed run, carrying whatever that run managed to produce first. */
export interface BrowserRunError extends Error {
	partialRunOutput?: RunResultPartial;
}

export type TabWorkerOutbound =
	| { type: "ready"; info: ReadyInfo }
	| { type: "init-failed"; error: TabRunErrorPayload }
	| { type: "result"; id: string; ok: true; payload: RunResultOk }
	| { type: "result"; id: string; ok: false; error: TabRunErrorPayload; partial?: RunResultPartial }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface TabWorkerTransport {
	send(msg: TabWorkerOutbound | TabWorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: TabWorkerOutbound | TabWorkerInbound) => void): () => void;
	close(): void;
}

import * as path from "node:path";
import { errorMessage, isCancellation, logger, trimTrailingSlashes, withTimeout } from "@veyyon/utils";
import type { Subprocess } from "bun";
import type { Browser } from "puppeteer-core";
import { adoptIntoPrimarySessionCpuBudget } from "../../../session/cpu-limit";
import { ToolAbortError, ToolError } from "../../core/tool-errors";
import { findFreeCdpPort, findReusableCdp, gracefulKillTreeOnce, killExistingByPath, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import type { HostIdentity } from "./host-identity";
import { BROWSER_PROTOCOL_TIMEOUT_MS, type LaunchedBrowser, launchHeadlessBrowser, loadPuppeteer } from "./launch";
import { preparePersistentProfile, profileLock, profileLockedError, removeProfile } from "./profiles";

export type PuppeteerBrowserKind =
	/** `profile` names a persistent profile directory the browser runs on; absent, it runs on a temporary one. */
	| { kind: "headless"; headless: boolean; profile?: string }
	| { kind: "spawned"; path: string }
	| { kind: "connected"; cdpUrl: string };

export type BrowserKind = PuppeteerBrowserKind | CmuxKind;

export type BrowserKindTag = BrowserKind["kind"];

/**
 * Upper bound on `browser.close()` for headless Chromium. Puppeteer waits for
 * the process to fully exit; a wedged Chromium would otherwise hang cleanup
 * forever (issue #5260), so we cap the wait and force-kill on timeout.
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	subprocess?: Subprocess;
	/** The temporary profile directory a headless launch created, removed when the handle is disposed. */
	profileDir?: string;
	/** The host-true identity a launched headless browser presents; each tab applies it to its own page. */
	identity?: HostIdentity;
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle;

const browsers = new Map<string, BrowserHandle>();

/**
 * Test seam: launch the visible kind without a window. It keeps its own registry key, so a hand-off
 * between hidden and visible still moves a tab between two Chromium processes on a host with no display.
 */
let visibleLaunchesHeadless = false;

export function setVisibleLaunchesHeadlessForTest(value: boolean): void {
	visibleLaunchesHeadless = value;
}

/**
 * Fail when `kind` cannot start on this host: a visible browser on a Linux host with no display. Checked
 * before a tab is moved to a window, so a move that cannot happen leaves the tab where it is.
 */
export function assertBrowserCanStart(kind: BrowserKind): void {
	if (kind.kind !== "headless" || kind.headless || visibleLaunchesHeadless) return;
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		throw new ToolError(
			"A visible browser needs a display, and this Linux host has none: DISPLAY and WAYLAND_DISPLAY are unset. Run veyyon in a desktop session, or under a virtual display such as Xvfb with DISPLAY set.",
		);
	}
}

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}${kind.profile === undefined ? "" : `:profile:${kind.profile}`}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	const existing = browsers.get(key);
	if (existing) {
		if ("client" in existing) return existing;
		if (existing.browser.connected) return existing;
		browsers.delete(key);
		await disposeBrowserHandle(existing, { kill: false });
	}
	// Short-circuit before launching: the tool wrapper's `untilAborted` only
	// rejects its outer promise on abort; without this check `openBrowserHandle`
	// would still fire and its result would land in `browsers` below.
	if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");

	const handle = await openBrowserHandle(kind, opts);
	// The launch may resolve AFTER the caller has already aborted (the outer
	// `untilAborted` rejects immediately on abort but does not cancel the
	// inner promise, and `launchHeadlessBrowser` does not accept a signal).
	// Without this branch the completed handle sits in `browsers` at
	// refCount:0 forever — no tab ever takes a hold, `releaseBrowser` never
	// fires, and `releaseAllTabs` walks `tabs`, not `browsers`, so the
	// orphaned Chromium/app process / puppeteer handle survives to process
	// exit. (Issue #3963.)
	if (opts.signal?.aborted) {
		await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(err => {
			logger.debug("Failed to dispose orphan browser after abort", {
				error: errorMessage(err),
			});
		});
		throw new ToolAbortError("Browser open aborted");
	}
	browsers.set(key, handle);
	return handle;
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = trimTrailingSlashes(rawCdpUrl);
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpUrl;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return {
			key: browserKey(kind),
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		assertBrowserCanStart(kind);
		const headless = kind.headless || visibleLaunchesHeadless;
		let userDataDir: string | undefined;
		if (kind.profile !== undefined) {
			// One Chromium per profile directory: the same profile open at the other visibility in this process holds it.
			for (const other of browsers.values()) {
				if (
					"browser" in other &&
					other.kind.kind === "headless" &&
					other.kind.profile === kind.profile &&
					other.browser.connected
				) {
					throw new ToolError(
						`Browser profile ${JSON.stringify(kind.profile)} is already open in the ${other.kind.headless ? "hidden" : "visible"} browser; close its tabs first.`,
					);
				}
			}
			userDataDir = await preparePersistentProfile(kind.profile);
		}
		let launched: LaunchedBrowser;
		try {
			launched = await launchHeadlessBrowser({ headless, viewport: opts.viewport, userDataDir });
		} catch (error) {
			// Two processes starting one profile at once: the one that lost finds the lock only now.
			const lock = userDataDir === undefined ? undefined : await profileLock(userDataDir);
			if (lock && kind.profile !== undefined) throw profileLockedError(kind.profile, lock);
			throw error;
		}
		const { browser, profileDir, identity } = launched;
		// Chromium is a real multi-process CPU load and puppeteer spawns it for us,
		// so the pid comes back off the handle rather than from a spawn hook.
		const chromiumPid = browser.process()?.pid;
		if (chromiumPid !== undefined) adoptIntoPrimarySessionCpuBudget(chromiumPid);
		return {
			key: browserKey(kind),
			kind,
			browser,
			profileDir,
			refCount: 0,
			identity,
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const reused = await findReusableCdp(exe, opts.signal);
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const killed = await killExistingByPath(exe, opts.signal);
		if (killed > 0) logger.debug("Killed existing instances before attach", { exe, killed });
		const port = await findFreeCdpPort();
		const launchArgs = [...(opts.appArgs ?? []), `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		// Only the branch that SPAWNS adopts. `reused` attaches to a process this
		// session did not start, and capping someone else's process is not ours.
		adoptIntoPrimarySessionCpuBudget(pid);
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			// A cancellation of any kind, deadline included, must not be rewrapped
			// as a ToolError: that would present a stop as a failure to attach.
			if (isCancellation(err)) throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: { kill: boolean }): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		// Only evict if the registry still points at THIS handle. After a disconnect,
		// `acquireBrowser` may have already replaced the entry with a fresh live handle
		// under the same key; deleting blindly would orphan that new browser.
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: { kill: boolean }): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.browser.connected) {
			// Puppeteer's `browser.close()` resolves only once the Chromium
			// process fully exits. A wedged Chromium (a known Windows failure
			// mode) leaves this await pending forever, freezing `releaseTab` in
			// the "Closing tab" phase (issue #5260). Bound it, then SIGKILL the
			// process tree so cleanup always completes.
			const proc = handle.browser.process();
			try {
				await withTimeout(handle.browser.close(), HEADLESS_CLOSE_TIMEOUT_MS, "Timed out closing headless browser");
			} catch (err) {
				logger.debug("Failed to close headless browser; force-killing", { error: (err as Error).message });
				if (proc?.pid !== undefined) await gracefulKillTreeOnce(proc.pid).catch(() => undefined);
			}
		}
		// After the process is gone, whether it closed, was killed or had already crashed.
		if (handle.profileDir !== undefined) await removeProfile(handle.profileDir);
		return;
	}
	if (handle.kind.kind === "connected") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: (err as Error).message });
		}
	}
	// Kill only what WE spawned. `pid` is also set when `findReusableCdp` attached
	// to an instance the user already had running (see the reuse branch above),
	// and `{ kill: true }` arrives from session dispose — so keying off `pid`
	// SIGKILLs the user's own Chrome/Electron on `/exit`. `subprocess` is set on
	// the spawn path only, which is the same distinction `puppeteer.connect`'s
	// failure handler already makes.
	if (opts.kill && handle.subprocess !== undefined) await gracefulKillTreeOnce(handle.subprocess.pid);
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}

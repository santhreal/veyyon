import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as BrowsersNs from "@puppeteer/browsers";
import { $which, errorMessage, getPuppeteerDir, logger } from "@veyyon/utils";
import { bestEffort } from "@veyyon/utils/discarded-fault";
import type { Browser, CDPSession, Connection, Page, default as Puppeteer } from "puppeteer-core";
import { ToolError } from "../../core/tool-errors";
import stealthTamperingScript from "../puppeteer/00_stealth_tampering.txt" with { type: "text" };
import stealthActivityScript from "../puppeteer/01_stealth_activity.txt" with { type: "text" };
import stealthHairlineScript from "../puppeteer/02_stealth_hairline.txt" with { type: "text" };
import stealthBotdScript from "../puppeteer/03_stealth_botd.txt" with { type: "text" };
import stealthIframeScript from "../puppeteer/04_stealth_iframe.txt" with { type: "text" };
import stealthWebglScript from "../puppeteer/05_stealth_webgl.txt" with { type: "text" };
import stealthScreenScript from "../puppeteer/06_stealth_screen.txt" with { type: "text" };
import stealthFontsScript from "../puppeteer/07_stealth_fonts.txt" with { type: "text" };
import stealthAudioScript from "../puppeteer/08_stealth_audio.txt" with { type: "text" };
import stealthPluginsScript from "../puppeteer/10_stealth_plugins.txt" with { type: "text" };
import stealthCodecsScript from "../puppeteer/12_stealth_codecs.txt" with { type: "text" };
import { readBrowserProduct } from "./browser-product";
import { HAS_TEXT_HANDLER, hasTextQueryHandler } from "./has-text";
import {
	type BrowserProduct,
	type HostIdentity,
	resolveHostIdentity,
	resolveScreenSize,
	resolveStealthProfile,
	resolveSupportedHost,
	resolveWindowPosition,
	type StealthProfile,
	SUPPORTED_HOSTS,
	type UserAgentMetadata,
} from "./host-identity";
import { createProfile, removeProfile } from "./profiles";

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

/**
 * Per-CDP-message timeout applied to every puppeteer launch/connect. Set above
 * `TOOL_TIMEOUTS.browser.max` (30s) so the agent-side wall-clock is the canonical
 * limit; this constant only catches genuinely stuck CDP sockets (renderer wedged,
 * connection dropped, etc.).
 */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;
const ENABLE_AUTOMATION_FLAG = "--enable-automation";
// Automation-tell launch flags that puppeteer-core adds by default. We suppress
// them via `ignoreDefaultArgs` (the supported escape hatch) to mirror xxxx's
// chromiumSwitches patch. `--enable-automation` is the loudest: it normally sets
// navigator.webdriver=true and shows the "controlled by automated software" infobar.
// Edge is the launch-stability exception: it can exit before CDP opens when this
// default flag is stripped, so Edge keeps Puppeteer's flag while our explicit
// `--disable-blink-features=AutomationControlled` launch arg still handles
// navigator.webdriver.
// `ignoreDefaultArgs` does exact-string matching, so each entry must be a flag that
// puppeteer emits verbatim. The default `--disable-features=...` string can't be
// matched this way; it is neutralized in the puppeteer-core patch (ChromeLauncher).
const STEALTH_IGNORE_DEFAULT_ARGS = [
	ENABLE_AUTOMATION_FLAG,
	"--disable-extensions",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
	"--disable-popup-blocking",
	"--disable-client-side-phishing-detection",
	"--allow-pre-commit-input",
	"--disable-ipc-flooding-protection",
	"--metrics-recording-only",
];

function isMicrosoftEdgeExecutable(executablePath: string | undefined): boolean {
	if (!executablePath) return false;
	const normalizedPath = executablePath.replaceAll("\\", "/").toLowerCase();
	const executableName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	return (
		executableName === "msedge.exe" ||
		executableName === "microsoft edge" ||
		executableName.startsWith("microsoft-edge")
	);
}

function stealthIgnoreDefaultArgs(executablePath: string | undefined): string[] {
	if (!isMicrosoftEdgeExecutable(executablePath)) return STEALTH_IGNORE_DEFAULT_ARGS.slice();
	return STEALTH_IGNORE_DEFAULT_ARGS.filter(arg => arg !== ENABLE_AUTOMATION_FLAG);
}

const PUPPETEER_SOURCE_URL_SUFFIX = "//# sourceURL=__puppeteer_evaluation_script__";

/**
 * Lazy-import puppeteer with `process.cwd` pointed at a scratch directory, so
 * cosmiconfig does not choke on a malformed `package.json` in the user's
 * project tree.
 *
 * The dynamic import is required: puppeteer-core probes the working directory
 * while its module body evaluates, so a static import would run before the
 * directory is safe.
 *
 * The redirect replaces `process.cwd` for the duration of the import rather
 * than calling `process.chdir`, and that difference matters in both directions.
 * `chdir` moves the whole process, so anything reading the working directory
 * while the import is in flight sees the scratch directory instead of the
 * user's project, and `@veyyon/utils` keeps its own `projectDir` that a bare
 * `chdir` silently desynchronizes. Restoring is worse: `chdir` back into a
 * directory the user has since deleted throws from a `finally` block, which
 * both masks the import's own result and strands the process in the scratch
 * directory for the rest of its life. Swapping the function has neither
 * failure mode, and it works in a Worker thread, where `process.chdir` does not
 * exist at all.
 */
let puppeteerModule: typeof Puppeteer | undefined;
export async function loadPuppeteer(): Promise<typeof Puppeteer> {
	if (puppeteerModule) return puppeteerModule;
	const safeDir = getPuppeteerDir();
	await Bun.write(path.join(safeDir, "package.json"), "{}");
	const realCwd = process.cwd;
	Object.defineProperty(process, "cwd", { value: () => safeDir, configurable: true });
	try {
		const puppeteerCore = await import("puppeteer-core");
		// Selectors with Playwright's `:has-text()` resolve through this handler (`normalizeSelector`).
		if (!puppeteerCore.Puppeteer.customQueryHandlerNames().includes(HAS_TEXT_HANDLER)) {
			puppeteerCore.Puppeteer.registerCustomQueryHandler(HAS_TEXT_HANDLER, hasTextQueryHandler);
		}
		puppeteerModule = puppeteerCore.default;
		return puppeteerModule;
	} finally {
		Object.defineProperty(process, "cwd", { value: realCwd, configurable: true });
	}
}

let browsersModule: typeof BrowsersNs | undefined;
async function loadBrowsers(): Promise<typeof BrowsersNs> {
	if (!browsersModule) {
		browsersModule = await import("@puppeteer/browsers");
	}
	return browsersModule;
}

/**
 * Resolve the Chromium executable puppeteer will launch, lazily downloading it
 * on first use via @puppeteer/browsers. Skipped when a system Chromium (NixOS)
 * or PUPPETEER_EXECUTABLE_PATH is set. The browser is cached under
 * ~/.veyyon/puppeteer (getPuppeteerDir). Returns undefined when platform
 * detection fails (puppeteer default resolution takes over). Exported so
 * real-browser tests can probe launchability and skip on hosts missing
 * Chrome's system libraries.
 */
let chromiumExecutablePromise: Promise<string | undefined> | undefined;
export async function ensureChromiumExecutable(): Promise<string | undefined> {
	const sysChrome = resolveSystemChromium();
	if (sysChrome) return sysChrome;
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	if (chromiumExecutablePromise) return chromiumExecutablePromise;

	chromiumExecutablePromise = (async () => {
		const browsers = await loadBrowsers();
		const platform = browsers.detectBrowserPlatform();
		if (!platform) {
			logger.warn("Could not detect browser platform; relying on puppeteer default resolution");
			return undefined;
		}
		const cacheDir = getPuppeteerDir();
		const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
		const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
		const executablePath = browsers.computeExecutablePath({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
		});
		if (fs.existsSync(executablePath)) return executablePath;

		logger.warn("Downloading Chromium for puppeteer (first browser use)", {
			buildId,
			platform,
			cacheDir,
		});
		let lastReportedPercent = -1;
		await browsers.install({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
			downloadProgressCallback: (downloaded, total) => {
				if (total <= 0) return;
				const pct = Math.floor((downloaded / total) * 100);
				if (pct >= lastReportedPercent + 10 || downloaded === total) {
					lastReportedPercent = pct;
					logger.debug(
						`Chromium download: ${pct}% (${Math.round(downloaded / 1_000_000)} / ${Math.round(total / 1_000_000)} MB)`,
					);
				}
			},
		});
		return executablePath;
	})().catch(err => {
		chromiumExecutablePromise = undefined;
		throw new ToolError(
			`Failed to install Chromium for puppeteer: ${(err as Error).message}. ` +
				"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});
	return chromiumExecutablePromise;
}

let resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		return st.isFile();
	} catch {
		// A candidate path we cannot stat is a candidate we cannot launch, so it is not the browser we
		// are looking for. The search moves to the next candidate and reports if every one fails.
		return false;
	}
}

function systemChromiumCandidates(): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	switch (process.platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = $which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {
				// Probing for NixOS. Unreadable `/etc` means not-NixOS for this purpose,
				// and the candidate list below is unaffected either way.
			}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

function resolveSystemChromium(): string | undefined {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (isExecutableFile(candidate)) {
			resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

export interface LaunchHeadlessOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	/** A persistent profile directory to run on, kept when the browser closes; a temporary one when absent. */
	userDataDir?: string;
}

/** A launched browser, the temporary profile directory it runs on when it runs on one, and the identity it presents. */
export interface LaunchedBrowser {
	readonly browser: Browser;
	/** The temporary profile this launch created, which whoever disposes the browser removes; absent on a persistent profile. */
	readonly profileDir?: string;
	/**
	 * The host-true identity a headless browser presents on every target, which each tab applies to its own page.
	 * Absent for a headful browser, which reports its own identity, and on a host outside `SUPPORTED_HOSTS`.
	 */
	readonly identity?: HostIdentity;
}

export async function launchHeadlessBrowser(opts: LaunchHeadlessOptions): Promise<LaunchedBrowser> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const initialViewport = {
		width: vp.width,
		height: vp.height,
		deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	};
	const puppeteer = await loadPuppeteer();
	const launchArgs = [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-blink-features=AutomationControlled",
		`--window-size=${initialViewport.width},${initialViewport.height}`,
	];
	const proxy = process.env.PUPPETEER_PROXY;
	if (proxy) {
		launchArgs.push(`--proxy-server=${proxy}`);
		// Chrome (since v72) bypasses proxies for localhost by default. When PUPPETEER_PROXY_BYPASS_LOOPBACK
		// is true, add <-loopback> so traffic to localhost reaches the proxy (e.g. for mitmdump/auth capture).
		const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
		if (bypassLoopback === "true" || bypassLoopback === "1" || bypassLoopback === "yes" || bypassLoopback === "on") {
			launchArgs.push("--proxy-bypass-list=<-loopback>");
		}
	}
	const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
	if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
		launchArgs.push("--ignore-certificate-errors");
	}
	const executablePath = await ensureChromiumExecutable();
	const profile = hostStealthProfile();
	let product: BrowserProduct | undefined;
	let identity: HostIdentity | undefined;
	if (opts.headless) {
		// The flag reaches what a DevTools override cannot: service and shared workers, and the request that
		// fetches a worker's script. Chrome names itself `HeadlessChrome` there otherwise.
		product = executablePath ? await readBrowserProduct(executablePath) : undefined;
		identity = product && (await hostIdentityFor(product));
		if (identity) launchArgs.push(`--user-agent=${identity.userAgent}`);
		// Headless Chrome's own screen is 800x600, smaller than its window.
		const screen = resolveScreenSize(profile, initialViewport);
		launchArgs.push(`--screen-info={${screen.width}x${screen.height}}`);
		// The page scripts give the screen a work area below the menu bar or above the taskbar; the window
		// sits inside it.
		const position = resolveWindowPosition(profile);
		launchArgs.push(`--window-position=${position.x},${position.y}`);
	}
	const temporaryProfile = opts.userDataDir === undefined ? await createProfile() : undefined;
	let browser: Browser | undefined;
	try {
		browser = await puppeteer.launch({
			headless: opts.headless,
			defaultViewport: opts.headless ? initialViewport : null,
			executablePath,
			args: launchArgs,
			ignoreDefaultArgs: stealthIgnoreDefaultArgs(executablePath),
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			userDataDir: opts.userDataDir ?? temporaryProfile,
		});
		if (opts.headless && !product) {
			product = productFromBrowserVersion(executablePath, await browser.version());
			identity = product && (await hostIdentityFor(product));
			logger.warn(
				"The headless browser launched without its host-true --user-agent flag, so its service and shared workers report a headless user agent",
				{
					executablePath,
					fix: "Check that `<browser> --version` prints the product name and version, or set PUPPETEER_EXECUTABLE_PATH to a Chrome that does.",
				},
			);
		}
		await holdTargetIdentity(browser, { identity, profile });
		return { browser, profileDir: temporaryProfile, identity };
	} catch (error) {
		if (browser) await bestEffort(browser.close(), "the browser goes with the launch that failed to finish");
		if (temporaryProfile !== undefined) await removeProfile(temporaryProfile);
		throw error;
	}
}

export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	if (!viewport) {
		await page.setViewport(DEFAULT_VIEWPORT);
		return;
	}
	await page.setViewport({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	});
}

// =====================================================================
// Stealth patches
// =====================================================================

interface PuppeteerCdpClient {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
	connection?: () => Connection | undefined;
}

/** The user agent and client hints a target reports, in the shape both `setUserAgentOverride` commands take. */
export interface UserAgentOverride {
	userAgent: string;
	userAgentMetadata: UserAgentMetadata;
}

function resolvePageClient(page: Page): PuppeteerCdpClient | null {
	const pageWithClient = page as Page & {
		_client?: (() => PuppeteerCdpClient) | PuppeteerCdpClient;
	};
	if (!pageWithClient._client) return null;
	return typeof pageWithClient._client === "function" ? pageWithClient._client() : pageWithClient._client;
}

const patchedClients = new WeakSet<object>();

function patchSourceUrl(page: Page): void {
	const client = resolvePageClient(page);
	if (!client) return;
	const clientKey = client as object;
	if (patchedClients.has(clientKey)) return;
	patchedClients.add(clientKey);
	const originalSend = client.send.bind(client);
	client.send = async (method: string, params?: Record<string, unknown>) => {
		const next = async (payload?: Record<string, unknown>) => {
			try {
				return await originalSend(method, payload);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes(
						"Protocol error (Network.getResponseBody): No resource with given identifier found",
					)
				) {
					return undefined;
				}
				throw error;
			}
		};
		if (!method || !params) {
			return next(params);
		}
		const key =
			method === "Runtime.evaluate"
				? "expression"
				: method === "Runtime.callFunctionOn"
					? "functionDeclaration"
					: null;
		if (!key) {
			return next(params);
		}
		const value = params[key];
		if (typeof value !== "string" || !value.includes(PUPPETEER_SOURCE_URL_SUFFIX)) {
			return next(params);
		}
		const patchedParams = { ...params, [key]: value.replace(PUPPETEER_SOURCE_URL_SUFFIX, "") };
		return next(patchedParams);
	};
}

/** macOS `ProductVersion`, which `platformVersion` reports; empty off macOS or when the plist is unreadable. */
async function readMacProductVersion(): Promise<string> {
	if (process.platform !== "darwin") return "";
	try {
		const plist = await fs.promises.readFile("/System/Library/CoreServices/SystemVersion.plist", "utf8");
		return plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
	} catch (error) {
		logger.debug("SystemVersion.plist is unreadable; the macOS version comes from the kernel release", {
			error: errorMessage(error),
		});
		return "";
	}
}

/** The identity real Chrome presents on this host for `product`, or undefined, reported, off the table. */
async function hostIdentityFor(product: BrowserProduct): Promise<HostIdentity | undefined> {
	const identity = resolveHostIdentity({
		platform: process.platform,
		machine: os.machine(),
		osRelease: os.release(),
		macProductVersion: await readMacProductVersion(),
		product,
	});
	if (!identity) {
		logger.warn("This host is outside the browser identity table, so the headless browser keeps its own identity", {
			platform: process.platform,
			machine: os.machine(),
			product: `${product.name} ${product.version}`,
			fix: "Record the host in SUPPORTED_HOSTS (browser/host-identity.ts) with the strings Chrome sends on it.",
		});
	}
	return identity;
}

/** The product a launched browser reports over CDP, for a binary that did not state its own before launch. */
function productFromBrowserVersion(
	executablePath: string | undefined,
	browserVersion: string,
): BrowserProduct | undefined {
	const version = browserVersion.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
	if (!version) return undefined;
	const binary = (executablePath ?? "").toLowerCase();
	const name = binary.includes("edge") ? "Microsoft Edge" : binary.includes("chromium") ? "Chromium" : "Google Chrome";
	return { name, version };
}

let cachedStealthProfile: StealthProfile | undefined;

/** What the page scripts present for this host: its OS, a GPU of that OS, window chrome, screens, capped cores. */
function hostStealthProfile(): StealthProfile {
	if (!cachedStealthProfile) {
		const host =
			resolveSupportedHost(process.platform, os.machine()) ??
			SUPPORTED_HOSTS.find(candidate => candidate.platform === process.platform && candidate.arch === "x64") ??
			SUPPORTED_HOSTS.find(candidate => candidate.platform === "linux" && candidate.arch === "x64");
		if (!host) throw new ToolError("SUPPORTED_HOSTS lost its linux x64 entry");
		cachedStealthProfile = resolveStealthProfile(host, os.cpus().length);
	}
	return cachedStealthProfile;
}

function wrapSession(session: CDPSession): PuppeteerCdpClient {
	return {
		send: async (method, params) => session.send(method as never, params as never),
		connection: () => session.connection(),
	};
}

/**
 * A protocol error that means the command does not apply to the target rather than that it failed: a
 * target type without the domain (a tab, the browser itself), a page with no context yet, or a target
 * that closed before the command landed.
 */
function isInapplicableTarget(error: unknown): boolean {
	const message = errorMessage(error);
	return (
		message.includes("wasn't found") ||
		message.includes("Session closed") ||
		message.includes("Target closed") ||
		message.includes("No target with given id") ||
		message.includes("Cannot find default execution context") ||
		message.includes("Execution context was destroyed") ||
		message.includes("Inspected target navigated or closed")
	);
}

/**
 * Apply the user-agent override through both CDP domains.
 *
 * The two are redundant on purpose: `Emulation` sets what the target's scripts read and `Network` what
 * its requests send, and either one covers the user agent string. Both commands leave before this
 * function first yields, so a target waiting for its debugger has them ahead of its resume.
 *
 * One failing is normal and stays quiet. Both failing on a target that should have taken the override
 * is reported with each reason: that target contradicts the rest of the browser, and a page that sees
 * it can tell it is automated. Both failing because the target has neither domain (a tab, the browser)
 * or is already gone is not a loss.
 */
export async function sendUserAgentOverride(client: PuppeteerCdpClient, override: UserAgentOverride): Promise<void> {
	const params: Record<string, unknown> = {
		userAgent: override.userAgent,
		userAgentMetadata: override.userAgentMetadata,
	};
	const results = await Promise.allSettled([
		client.send("Network.setUserAgentOverride", params),
		client.send("Emulation.setUserAgentOverride", params),
	]);
	const failures: string[] = [];
	let inapplicable = 0;
	results.forEach((result, index) => {
		if (result.status === "fulfilled") return;
		if (isInapplicableTarget(result.reason)) inapplicable++;
		failures.push(`${index === 0 ? "Network" : "Emulation"}: ${errorMessage(result.reason)}`);
	});
	if (failures.length < results.length || inapplicable === results.length) return;
	logger.warn("The browser user-agent override could not be applied, so this target reports itself as automated", {
		userAgent: override.userAgent,
		failures,
		fix: "Sites may block or behave differently for this target. Check that the browser supports the CDP Emulation domain, or launch without the stealth user agent.",
	});
}

/** What each target of a browser receives the moment it attaches. */
interface TargetIdentity {
	/** Absent for a headful browser, which reports its own identity, and on a host off the table. */
	readonly identity: HostIdentity | undefined;
	readonly profile: StealthProfile;
}

/** Send a command, reporting its failure only when the target should have taken it. */
function sendToTarget(client: PuppeteerCdpClient, method: string, params: Record<string, unknown>): void {
	void client.send(method, params).catch(error => {
		if (isInapplicableTarget(error)) return;
		logger.warn("A browser target did not take part of its identity, so it disagrees with the rest of the browser", {
			method,
			error: errorMessage(error),
			fix: "Sites that compare the page with its workers may see the difference. Check that the browser supports this CDP method.",
		});
	});
}

/**
 * Send a target its identity. Every command leaves synchronously: puppeteer resumes a target that waits
 * for its debugger as soon as the `sessionattached` listeners return, so a worker runs the prelude before
 * its own first line and reads the overrides from its first line on. The target's type is not known at
 * that point, so a page or a tab receives the same commands and ignores what does not apply to it.
 */
function applyTargetIdentity(client: PuppeteerCdpClient, target: TargetIdentity, prelude: string): void {
	sendToTarget(client, "Runtime.evaluate", { expression: prelude });
	sendToTarget(client, "Emulation.setHardwareConcurrencyOverride", {
		hardwareConcurrency: target.profile.hardwareConcurrency,
	});
	if (target.identity) {
		void sendUserAgentOverride(client, {
			userAgent: target.identity.userAgent,
			userAgentMetadata: target.identity.userAgentMetadata,
		});
	}
}

/** Connections whose attaching targets already receive their identity. */
const identityConnections = new WeakSet<Connection>();

/**
 * Give every target that attaches to `connection` from now on its identity. Every puppeteer connection
 * to a browser attaches to every target and resumes the ones waiting for a debugger, so each connection
 * this process opens is hooked, and whichever resumes a worker first has sent the prelude ahead of it.
 */
function presentIdentityOn(connection: Connection, target: TargetIdentity): void {
	if (identityConnections.has(connection)) return;
	identityConnections.add(connection);
	const prelude = buildWorkerPrelude(target.profile);
	connection.on("sessionattached", session => applyTargetIdentity(wrapSession(session), target, prelude));
}

/**
 * Present the identity on every target of a browser this process launched, for the browser's whole life:
 * hook the launch connection, and keep one browser-level session attached to every target. Puppeteer
 * detaches from a service worker right after resuming it, and a detached session's overrides go with it.
 */
async function holdTargetIdentity(browser: Browser, target: TargetIdentity): Promise<void> {
	const session = await browser.target().createCDPSession();
	const connection = session.connection();
	if (connection) presentIdentityOn(connection, target);
	await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}

/**
 * `Window_Proxy` for the page scripts and the worker prelude: a Proxy that refuses a prototype whose
 * chain leads back to it. An object refuses one with a TypeError, but a Proxy forwards the change to its
 * target, whose check stops at the Proxy, and the next property read recurses until the stack
 * overflows; CreepJS reads that difference as a lie. Needs `Native_Proxy`, `Object_assign`,
 * `Reflect_apply`, `Reflect_getPrototypeOf` and `Reflect_setPrototypeOf` in scope.
 */
const GUARDED_PROXY_SOURCE = `const Window_Proxy = function Proxy(target, handler) {
	let proxy = null;
	const guarded = Object_assign({}, handler);
	guarded.setPrototypeOf = (proxied, proto) => {
		for (let link = proto, steps = 0; link !== null && steps < 4096; steps += 1) {
			if (link === proxy) return false;
			link = Reflect_getPrototypeOf(link);
		}
		return handler.setPrototypeOf
			? Reflect_apply(handler.setPrototypeOf, handler, [proxied, proto])
			: Reflect_setPrototypeOf(proxied, proto);
	};
	proxy = new Native_Proxy(target, guarded);
	return proxy;
};`;

/**
 * The script a worker evaluates before its own: the page's WebGL patch over the worker's natives, which
 * nothing has touched yet. A page, frame or tab evaluates it too and returns at the first line.
 */
function buildWorkerPrelude(profile: StealthProfile): string {
	return `(() => {
	if (typeof WorkerGlobalScope === "undefined" || !(self instanceof WorkerGlobalScope)) return;
	const Page_WeakMap = WeakMap;
	const Page_WeakMap_get = WeakMap.prototype.get;
	const Page_WeakMap_set = WeakMap.prototype.set;
	const Reflect_apply = Reflect.apply;
	const Reflect_ownKeys = Reflect.ownKeys;
	const Reflect_getPrototypeOf = Reflect.getPrototypeOf;
	const Reflect_setPrototypeOf = Reflect.setPrototypeOf;
	const Object_assign = Object.assign;
	const Object_getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const Object_defineProperty = Object.defineProperty;
	const Object_getPrototypeOf = Object.getPrototypeOf;
	const Object_create = Object.create;
	const Math_max = Math.max;
	const Native_Proxy = Proxy;
	${GUARDED_PROXY_SOURCE}
	const stealthProfile = ${JSON.stringify(profile)};
	const nativeFunctionSources = new Page_WeakMap();
	const patchToString = (fn, name) => {
		if (typeof fn === "function") Reflect_apply(Page_WeakMap_set, nativeFunctionSources, [fn, "function " + (name || "") + "() { [native code] }"]);
		return fn;
	};
	const toStringDescriptor = Object_getOwnPropertyDescriptor(Function.prototype, "toString");
	if (!toStringDescriptor || typeof toStringDescriptor.value !== "function") return;
	const functionToString = new Window_Proxy(toStringDescriptor.value, {
		apply(target, thisArg, args) {
			const source = Reflect_apply(Page_WeakMap_get, nativeFunctionSources, [thisArg]);
			return source === undefined ? Reflect_apply(target, thisArg, args) : source;
		},
	});
	patchToString(functionToString, "toString");
	Object_defineProperty(Function.prototype, "toString", { ...toStringDescriptor, value: functionToString });
	try {
		${stealthWebglScript};
	} catch (e) {}
})()`;
}

const STEALTH_PATCH_SCRIPTS = [
	stealthTamperingScript,
	stealthActivityScript,
	stealthHairlineScript,
	stealthBotdScript,
	stealthIframeScript,
	stealthWebglScript,
	stealthScreenScript,
	stealthFontsScript,
	stealthAudioScript,
	stealthPluginsScript,
	stealthCodecsScript,
];

/**
 * The document-start bootstrap every frame of a page runs: pristine natives, a masked
 * `Function.prototype.toString`, the host's stealth profile, then each patch script. `headless` says
 * whether the window has no chrome of its own for the geometry patch to supply.
 */
function buildStealthInjectionScript(scripts: readonly string[], profile: StealthProfile, headless: boolean): string {
	// Each patch is wrapped in its own in-page `try`/`catch` on purpose: the
	// patches are independent, and one that throws on a given browser build must
	// not take the others down with it. There is no channel back from a
	// document-start preload, so the isolation is the whole contract.
	const joint = scripts
		.map(
			script => `
		try {
			${script};
		} catch (e) {}
	`,
		)
		.join(";\n");

	return `(() => {
				const Page_Function_toString = Function.prototype.toString;
				const Page_FunctionToStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
				const Page_WeakMap = WeakMap;
				const Page_WeakMap_get = Page_WeakMap.prototype.get;
				const Page_WeakMap_set = Page_WeakMap.prototype.set;
				// Native function cache - captured before any tampering.
				// A same-origin iframe yields natives uncontaminated by page-level
				// tampering, but at document-start (when this preload runs) there is
				// no documentElement to attach it to. In that case the page itself
				// hasn't executed yet, so window's own natives are still pristine —
				// fall back to window instead of bailing, otherwise none of the
				// fingerprint patches below would ever run.
				let iframe = null;
				const container = document.head ?? document.documentElement;
				if (container) {
					iframe = document.createElement("iframe");
					iframe.style.display = "none";
					container.appendChild(iframe);
					if (!iframe.contentWindow) iframe = null;
				}
				try {
					const nativeWindow = iframe ? iframe.contentWindow : window;

					// Cache pristine native functions
					const Function_toString = nativeWindow.Function.prototype.toString;
					const Object_getOwnPropertyDescriptor = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_getOwnPropertyDescriptors = nativeWindow.Object.getOwnPropertyDescriptors;
					const Object_getPrototypeOf = nativeWindow.Object.getPrototypeOf;
					const Object_defineProperty = nativeWindow.Object.defineProperty;
					const Object_getOwnPropertyDescriptorOriginal = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_create = nativeWindow.Object.create;
					const Object_keys = nativeWindow.Object.keys;
					const Object_getOwnPropertyNames = nativeWindow.Object.getOwnPropertyNames;
					const Object_entries = nativeWindow.Object.entries;
					const Object_setPrototypeOf = nativeWindow.Object.setPrototypeOf;
					const Object_assign = nativeWindow.Object.assign;
					const Window_setTimeout = nativeWindow.setTimeout;
					const Math_random = nativeWindow.Math.random;
					const Math_floor = nativeWindow.Math.floor;
					const Math_max = nativeWindow.Math.max;
					const Math_min = nativeWindow.Math.min;
					const Window_Event = nativeWindow.Event;
					const Promise_resolve = nativeWindow.Promise.resolve.bind(nativeWindow.Promise);
					const Window_Blob = nativeWindow.Blob;
					const Native_Proxy = nativeWindow.Proxy;
					const Reflect_get = nativeWindow.Reflect.get;
					const Reflect_set = nativeWindow.Reflect.set;
					const Reflect_apply = nativeWindow.Reflect.apply;
					const Reflect_construct = nativeWindow.Reflect.construct;
					const Reflect_defineProperty = nativeWindow.Reflect.defineProperty;
					const Reflect_deleteProperty = nativeWindow.Reflect.deleteProperty;
					const Reflect_getOwnPropertyDescriptor = nativeWindow.Reflect.getOwnPropertyDescriptor;
					const Reflect_getPrototypeOf = nativeWindow.Reflect.getPrototypeOf;
					const Reflect_has = nativeWindow.Reflect.has;
					const Reflect_isExtensible = nativeWindow.Reflect.isExtensible;
					const Reflect_ownKeys = nativeWindow.Reflect.ownKeys;
					const Reflect_preventExtensions = nativeWindow.Reflect.preventExtensions;
					const Reflect_setPrototypeOf = nativeWindow.Reflect.setPrototypeOf;
					${GUARDED_PROXY_SOURCE}
					const Intl_DateTimeFormat = nativeWindow.Intl.DateTimeFormat;
					const Date_constructor = nativeWindow.Date;

					const nativeFunctionSources = new Page_WeakMap();
					const makeNativeString = (name) => "function " + (name || "") + "() { [native code] }";
					const registerNativeSource = (fn, source) => {
						if (typeof fn === "function") Reflect_apply(Page_WeakMap_set, nativeFunctionSources, [fn, source]);
						return fn;
					};
					const patchToString = (fn, name) => registerNativeSource(fn, makeNativeString(name));
					const stealthProfile = ${JSON.stringify({ ...profile, headless })};
					if (${scripts.length > 0 ? "true" : "false"}) {
						const functionToString = new Window_Proxy(Page_Function_toString, {
							apply(target, thisArg, args) {
								const source = Reflect_apply(Page_WeakMap_get, nativeFunctionSources, [thisArg]);
								if (source) return source;
								return Reflect_apply(target, thisArg, args || []);
							},
							get(target, key, receiver) {
								return Reflect_get(target, key, receiver);
							},
						});
						registerNativeSource(functionToString, makeNativeString("toString"));
						Object_defineProperty(Function.prototype, "toString", {
							...(Page_FunctionToStringDescriptor || {
								writable: true,
								configurable: true,
								enumerable: false,
							}),
							value: functionToString,
						});
					}

					${joint}
				} finally {
					if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
				}})();`;
}

/**
 * Present the host-true identity on a headless page and install the page scripts before its first
 * navigation. `identity` is the one the page's browser launched with; undefined keeps the browser's own.
 * The overrides and scripts hold while the connection that sent them is open.
 */
export async function applyStealthPatches(page: Page, identity: HostIdentity | undefined): Promise<void> {
	patchSourceUrl(page);
	const target: TargetIdentity = { identity, profile: hostStealthProfile() };
	const client = resolvePageClient(page);
	if (client) {
		// This tab's connection resumes the page's workers as well, so it hooks them like the launch connection.
		const connection = client.connection?.();
		if (connection) presentIdentityOn(connection, target);
		// The page itself attached before that hook existed.
		sendToTarget(client, "Emulation.setHardwareConcurrencyOverride", {
			hardwareConcurrency: target.profile.hardwareConcurrency,
		});
		if (identity) {
			await sendUserAgentOverride(client, {
				userAgent: identity.userAgent,
				userAgentMetadata: identity.userAgentMetadata,
			});
		}
	}
	// Only a headless launch resolves an identity. Without one, a headless browser still names its product
	// `HeadlessChrome` over the protocol; the `--user-agent` flag replaces that name, so it is not the test.
	const headless = identity !== undefined || (await page.browser().version()).startsWith("Headless");
	await page.evaluateOnNewDocument(buildStealthInjectionScript(STEALTH_PATCH_SCRIPTS, target.profile, headless));
}

export function stealthIgnoreDefaultArgsForTest(executablePath: string | undefined): string[] {
	return stealthIgnoreDefaultArgs(executablePath);
}

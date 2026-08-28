import * as net from "node:net";
import { ProcessStatus } from "@veyyon/natives";
import { trimTrailingSlashes } from "@veyyon/utils";
import { processHandle, processHandlesByPath } from "@veyyon/utils/native-process";
import type { Browser, Page } from "puppeteer-core";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { ToolError, throwIfAborted } from "../tool-errors";

const ATTACH_TARGET_SKIP_PATTERN =
	/request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker/i;

export async function findFreeCdpPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		if (addr && typeof addr === "object" && typeof addr.port === "number") {
			const port = addr.port;
			server.close(closeErr => (closeErr ? reject(closeErr) : resolve(port)));
		} else {
			server.close();
			reject(new Error("Failed to allocate ephemeral CDP port"));
		}
	});
	return promise;
}

export async function waitForCdp(cdpUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	const probeUrl = `${trimTrailingSlashes(cdpUrl)}/json/version`;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		const probeTimeout = scopedTimeoutSignal(2000, signal);
		try {
			const res = await fetch(probeUrl, { signal: probeTimeout.signal });
			if (res.ok) {
				await res.body?.cancel();
				return;
			}
			lastErr = new Error(`HTTP ${res.status}`);
			await res.body?.cancel();
		} catch (err) {
			if (signal?.aborted) throwIfAborted(signal);
			lastErr = err;
		} finally {
			probeTimeout.cancel();
		}
		await Bun.sleep(150);
	}
	throw new ToolError(
		`Timed out waiting for CDP endpoint ${cdpUrl}${lastErr instanceof Error ? `: ${lastErr.message}` : ""}`,
	);
}

function findCdpPortInArgs(args: string[]): number | null {
	for (const arg of args) {
		const m = /^--remote-debugging-port=(\d+)$/.exec(arg);
		if (m) {
			const port = Number.parseInt(m[1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--remote-debugging-port") {
			const port = Number.parseInt(args[i + 1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	return null;
}

async function probeCdpAt(port: number, signal?: AbortSignal): Promise<boolean> {
	const probeTimeout = scopedTimeoutSignal(1500, signal);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: probeTimeout.signal });
		await res.body?.cancel();
		return res.ok;
	} catch {
		return false;
	} finally {
		probeTimeout.cancel();
	}
}

export async function findReusableCdp(
	exe: string,
	signal?: AbortSignal,
): Promise<{ cdpUrl: string; pid: number } | null> {
	const candidates = processHandlesByPath(exe).filter(p => p.status() === ProcessStatus.Running);
	for (const proc of candidates) {
		let args: string[];
		try {
			args = proc.args();
		} catch {
			continue;
		}
		const port = findCdpPortInArgs(args);
		if (port === null) continue;
		if (await probeCdpAt(port, signal)) {
			return { cdpUrl: `http://127.0.0.1:${port}`, pid: proc.pid };
		}
	}
	return null;
}

export async function pickElectronTarget(browser: Browser, matcher?: string): Promise<Page> {
	const discoveredPages = await Promise.all(
		browser.targets().map(async target => {
			if (String(target.type()) !== "page") return null;
			return await target.page().catch(() => null);
		}),
	);
	const usablePages = discoveredPages.filter((page): page is Page => page !== null);
	if (usablePages.length > 0) {
		return pickPageFromList(usablePages, matcher);
	}

	const fallbackPages = await browser.pages();
	if (!fallbackPages.length) {
		throw new ToolError("No page targets available on the attached browser");
	}
	return pickPageFromList(fallbackPages, matcher);
}

async function enrichPages(pages: Page[]): Promise<Array<{ page: Page; url: string; title: string }>> {
	return await Promise.all(
		pages.map(async page => ({
			page,
			url: page.url(),
			title: ((await page.title().catch(() => "")) ?? "").trim(),
		})),
	);
}

async function pickPageFromList(pages: Page[], matcher?: string): Promise<Page> {
	const enriched = await enrichPages(pages);
	if (matcher) {
		const needle = matcher.toLowerCase();
		const hit = enriched.find(p => p.url.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle));
		if (hit) return hit.page;
		const summary = enriched.map(p => `- ${p.title || "(untitled)"}  ${p.url}`).join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(matcher)}. Available pages:\n${summary}`);
	}
	return (
		enriched.find(p => !ATTACH_TARGET_SKIP_PATTERN.test(p.url) && !ATTACH_TARGET_SKIP_PATTERN.test(p.title))?.page ??
		enriched[0]!.page
	);
}

export async function gracefulKillTreeOnce(pid: number, gracePeriodMs = 2000): Promise<void> {
	const process = processHandle(pid);
	if (!process) return;
	await process.terminate({ gracefulMs: gracePeriodMs, timeoutMs: 500 });
}

export async function killExistingByPath(executablePath: string, signal?: AbortSignal): Promise<number> {
	const processes = processHandlesByPath(executablePath);
	if (!processes.length) return 0;
	const results = await Promise.all(
		processes.map(async process => {
			throwIfAborted(signal);
			return await process.terminate({ gracefulMs: 3000, timeoutMs: 1000 });
		}),
	);
	return results.length;
}

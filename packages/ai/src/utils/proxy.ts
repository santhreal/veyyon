import * as net from "node:net";
import * as tls from "node:tls";
import * as AIError from "../error";
import type { FetchImpl } from "../types";

/**
 * Checks if a host is local or cloud metadata, which should always bypass the proxy
 * (e.g. localhost, 127/8, ::1, 169.254.169.254, metadata.google.internal).
 */
export function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();

	// Hostnames: localhost and the cloud metadata service.
	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}

	// Strip IPv6 brackets before numeric checks.
	const ip = lowerHost.replace(/^\[|\]$/g, "");
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	return v4 ? isLocalIPv4(Number(v4[1]), Number(v4[2])) : isLocalIPv6(ip);
}

/**
 * IPv4 loopback (127/8), unspecified (0/8), RFC1918 private (10/8, 172.16/12,
 * 192.168/16) and link-local (169.254/16 — covers IMDS 169.254.169.254 and
 * ECS credentials 169.254.170.2), judged from the first two octets. None are reachable through a
 * remote egress proxy, and credential/metadata probes must never leak to one.
 */
function isLocalIPv4(a: number, b: number): boolean {
	if (a === 127 || a === 10 || a === 0) return true;
	if (a === 169) return b === 254;
	if (a === 192) return b === 168;
	return a === 172 && b >= 16 && b <= 31;
}

/** IPv6 loopback (::1), unspecified (::), link-local (fe80::/10) and unique-local (fc00::/7 —
 *  covers EC2 IPv6 IMDS fd00:ec2::254), given a lowercased address without brackets. */
function isLocalIPv6(ip: string): boolean {
	return ip === "::1" || ip === "::" || /^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip);
}

/** One NO_PROXY entry: a host matched exactly or as a suffix, optionally on one port. */
interface NoProxyRule {
	/** `*`: every host on every port. */
	any: boolean;
	/** The port the rule is limited to, or undefined for every port. */
	port: string | undefined;
	/** The host the rule matches exactly. */
	exact: string;
	/** The suffix a subdomain of `exact` ends with. */
	suffix: string;
}

/** The last NO_PROXY value read and its parsed rules: the value is static for a process, and the
 *  rules are asked for on every proxied request. */
let noProxyRules: { raw: string; rules: NoProxyRule[] } | undefined;

function parseNoProxyRule(rule: string): NoProxyRule {
	let host = rule.toLowerCase();
	let port: string | undefined;
	// A bracketed address takes its port after the closing bracket, and a bare IPv6 address has no
	// port: its colons are all its own.
	if (host.includes("]:") || (!host.includes("]") && host.includes(":") && !net.isIPv6(host))) {
		const lastColon = host.lastIndexOf(":");
		port = host.slice(lastColon + 1) || undefined;
		host = host.slice(0, lastColon);
	}
	// Strip IPv6 brackets
	host = host.replace(/^\[|\]$/g, "");
	if (net.isIPv6(host)) host = canonicalIPv6(host);
	// A leading dot matches the bare domain and its subdomains.
	const dotted = host.startsWith(".");
	return { any: rule === "*", port, exact: dotted ? host.slice(1) : host, suffix: dotted ? host : `.${host}` };
}

/** `address` in the compressed lowercase form a URL's hostname writes it in, without brackets, so
 *  `2001:0DB8:0::1` names the host `[2001:db8::1]`. */
function canonicalIPv6(address: string): string {
	const hostname = URL.parse(`http://[${address}]/`)?.hostname;
	return hostname ? hostname.slice(1, -1) : address;
}

function parsedNoProxyRules(raw: string): NoProxyRule[] {
	if (noProxyRules?.raw === raw) return noProxyRules.rules;
	const rules: NoProxyRule[] = [];
	for (const rule of raw.split(/[,\s]+/)) if (rule) rules.push(parseNoProxyRule(rule));
	noProxyRules = { raw, rules };
	return rules;
}

/**
 * Check if the url should bypass the proxy due to hard-coded localhost/metadata checks
 * or custom NO_PROXY/no_proxy environment variables rules.
 */
export function shouldBypassProxy(urlObj: URL): boolean {
	if (isLocalOrMetadataHost(urlObj.hostname)) return true;
	const noProxyVal = process.env.NO_PROXY || process.env.no_proxy;
	if (!noProxyVal) return false;
	// A URL writes an IPv6 hostname in brackets and already lowercased; an entry is compared without them.
	const hostname = urlObj.hostname;
	const targetHost = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname.toLowerCase();
	const targetPort = urlObj.port || (urlObj.protocol === "https:" ? "443" : "80");
	for (const rule of parsedNoProxyRules(noProxyVal)) {
		if (rule.any) return true;
		if (rule.port !== undefined && rule.port !== targetPort) continue;
		if (targetHost === rule.exact || targetHost.endsWith(rule.suffix)) return true;
	}
	return false;
}

const proxyCache = new Map<string, string | undefined>();

/** Test seam: clears the provider proxy cache. */
export function __resetProxyCache(): void {
	proxyCache.clear();
}

/**
 * Normalizes provider id (e.g. github-copilot -> VEYYON_PROXY_GITHUB_COPILOT) and looks it up.
 * If not found, falls back to VEYYON_PROXY. Results are memoized because env values are static
 * for the lifetime of the process and this function is called for every outgoing request.
 */
export function getProxyForProvider(provider: string): string | undefined {
	if (proxyCache.has(provider)) {
		return proxyCache.get(provider);
	}

	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const envKey = `VEYYON_PROXY_${normalized}`;
	const value = Bun.env[envKey] || Bun.env.VEYYON_PROXY;
	proxyCache.set(provider, value);
	return value;
}

/**
 * Wraps a fetch implementation to inject proxy options for non-local hosts.
 */
export function wrapFetchForProxy(fetchImpl: FetchImpl, provider: string): FetchImpl {
	const proxyUrl = getProxyForProvider(provider);
	if (!proxyUrl) {
		return fetchImpl;
	}

	const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const urlStr = input instanceof Request ? input.url : input.toString();
		let urlObj: URL;
		try {
			urlObj = new URL(urlStr);
		} catch {
			// Fallback to calling fetch unmodified if URL is unparseable
			return fetchImpl(input, init);
		}

		if (shouldBypassProxy(urlObj)) {
			return fetchImpl(input, init);
		}

		const mergedInit = { ...(init ?? {}), proxy: proxyUrl };
		return fetchImpl(input, mergedInit);
	};

	if (fetchImpl.preconnect) {
		wrapped.preconnect = fetchImpl.preconnect;
	}
	return wrapped;
}

export interface ConnectProxiedSocketOptions {
	/** Caller cancellation for the proxy TCP/TLS handshake and CONNECT tunnel. */
	signal?: AbortSignal;
	/** Maximum wall-clock time to establish the final TLS tunnel. Disabled when absent or non-positive. */
	timeoutMs?: number;
}

/**
 * Tunnel a socket connection through an HTTP CONNECT proxy.
 * This is used specifically to wrap Node's `http2.connect(baseUrl, { createConnection })` for Cursor.
 */
export async function connectProxiedSocket(
	proxyUrlStr: string,
	targetUrlStr: string,
	options?: ConnectProxiedSocketOptions,
): Promise<tls.TLSSocket> {
	if (options?.signal?.aborted) {
		throw new AIError.RequestAbortError("Proxy tunnel aborted");
	}

	const proxyUrl = new URL(proxyUrlStr);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname;

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	let rawSocket: net.Socket | undefined;
	let tunnelSocket: tls.TLSSocket | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let responseData = "";
	let settled = false;

	const cleanup = (): void => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		options?.signal?.removeEventListener("abort", onAbort);
		rawSocket?.off("error", onRawError);
		rawSocket?.off("close", onRawClose);
		rawSocket?.off(readyEvent, onProxyReady);
		rawSocket?.off("data", onProxyData);
		tunnelSocket?.off("secureConnect", onTunnelReady);
		tunnelSocket?.off("error", onTunnelError);
		tunnelSocket?.off("close", onTunnelClose);
	};
	// Calling `socket.destroy()` or `socket.end()` leaves unread CONNECT request
	// bytes in the proxy server's TCP receive buffer. When unread data is pending,
	// TCP FIN teardown does not close the peer socket stream on Node or Bun.
	// `socket.resetAndDestroy()` sends a TCP RST packet that tears down the
	// connection immediately at both OS and stream levels on the peer.
	const destroyInProgress = (): void => {
		if (tunnelSocket) {
			if (typeof tunnelSocket.resetAndDestroy === "function") {
				tunnelSocket.resetAndDestroy();
			} else {
				tunnelSocket.destroy();
			}
		}
		if (rawSocket) {
			if (typeof rawSocket.resetAndDestroy === "function") {
				rawSocket.resetAndDestroy();
			} else {
				rawSocket.destroy();
			}
		}
	};
	const rejectOnce = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		destroyInProgress();
		reject(error);
	};
	const resolveOnce = (socket: tls.TLSSocket): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const onAbort = (): void => rejectOnce(new AIError.RequestAbortError("Proxy tunnel aborted"));
	const onRawError = (error: Error): void => rejectOnce(error);
	const onTunnelError = (error: Error): void => rejectOnce(error);
	const onTunnelClose = (): void => {
		if (settled) return;
		rejectOnce(new AIError.ValidationError("Proxy tunnel closed before handshake established"));
	};
	const onTunnelReady = (): void => {
		if (!tunnelSocket) return;
		resolveOnce(tunnelSocket);
	};
	const onRawClose = (): void => {
		if (settled) return;
		rejectOnce(new AIError.ValidationError("Proxy connection closed before tunnel established"));
	};
	const onProxyData = (chunk: Buffer): void => {
		if (!rawSocket) return;
		responseData += chunk.toString("binary");
		if (!responseData.includes("\r\n\r\n")) return;

		rawSocket.off("data", onProxyData);
		rawSocket.off("error", onRawError);
		rawSocket.off("close", onRawClose);

		const firstLine = responseData.split("\r\n")[0];
		if (!firstLine.includes(" 200 ")) {
			rejectOnce(new AIError.ValidationError(`Proxy tunnel failed: ${firstLine}`));
			return;
		}

		// Read the just-connected socket through a local const: `tunnelSocket` is a
		// closure-captured `let`, so TS widens it back to `| undefined` at every read
		// even right after this assignment. The local keeps the listener wiring typed.
		const socket = tls.connect({
			socket: rawSocket,
			servername: targetHost,
			ALPNProtocols: ["h2"],
		});
		tunnelSocket = socket;
		socket.once("secureConnect", onTunnelReady);
		socket.once("error", onTunnelError);
		socket.once("close", onTunnelClose);
	};
	const onProxyReady = (): void => {
		if (!rawSocket) return;
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);
		rawSocket.on("data", onProxyData);
	};

	options?.signal?.addEventListener("abort", onAbort, { once: true });
	if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		const timeoutMs = Math.trunc(options.timeoutMs);
		timeout = setTimeout(() => {
			rejectOnce(new AIError.StreamTimeoutError(`Proxy tunnel timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref?.();
	}

	// Local const for the same reason as tunnelSocket above: the closure-captured
	// `rawSocket` let is not narrowed after assignment, so wire listeners via `socket`.
	const socket = useProxySsl
		? tls.connect({
				host: proxyHost,
				port: proxyPort,
			})
		: net.connect({
				host: proxyHost,
				port: proxyPort,
			});
	rawSocket = socket;
	socket.once("error", onRawError);
	socket.once("close", onRawClose);
	socket.once(readyEvent, onProxyReady);

	return promise;
}

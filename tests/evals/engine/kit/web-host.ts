/**
 * A site a trial is performed against: one handler behind an HTTP server on 127.0.0.1, on a port
 * the kernel picks, alive for one trial.
 *
 * Two sites are two origins, so a task that needs a cross-origin frame or a second service hosts
 * two. Nothing here reaches the network: a task's whole world is the sites its suite starts.
 */

import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request, read in full. */
export interface SiteRequest {
	readonly method: string;
	readonly url: URL;
	readonly headers: http.IncomingHttpHeaders;
	readonly cookies: Readonly<Record<string, string>>;
	readonly body: string;
}

export interface SetCookie {
	readonly name: string;
	readonly value: string;
	/** Seconds; 0 deletes the cookie. */
	readonly maxAge?: number;
	readonly httpOnly?: boolean;
}

export interface SiteResponse {
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string | Uint8Array;
	readonly cookies?: readonly SetCookie[];
}

export type SiteHandler = (request: SiteRequest) => SiteResponse | Promise<SiteResponse>;

export interface HostedSite {
	/** `http://127.0.0.1:<port>`, no trailing slash. */
	readonly origin: string;
	close(): Promise<void>;
}

/** A request body larger than this is refused: no page a task serves posts more. */
const MAX_BODY_BYTES = 1_048_576;

export async function hostSite(handler: SiteHandler): Promise<HostedSite> {
	const server = http.createServer((incoming, outgoing) => {
		void serve(handler, incoming, outgoing);
	});
	// A browser keeps idle connections open, and a close waits for every one of them.
	const sockets = new Set<Socket>();
	server.on("connection", socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	const { promise: listening, resolve: onListening, reject: onError } = Promise.withResolvers<void>();
	server.once("error", onError);
	server.listen(0, "127.0.0.1", () => onListening());
	await listening;
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}

async function serve(handler: SiteHandler, incoming: http.IncomingMessage, outgoing: http.ServerResponse) {
	let response: SiteResponse;
	try {
		const body = await readBody(incoming);
		const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`);
		response = await handler({
			method: incoming.method ?? "GET",
			url,
			headers: incoming.headers,
			cookies: parseCookies(incoming.headers.cookie),
			body,
		});
	} catch (error) {
		response = text(`${error instanceof Error ? error.message : String(error)}\n`, { status: 500 });
	}
	const headers: Record<string, string | string[]> = { "cache-control": "no-store", ...response.headers };
	if (response.cookies?.length) headers["set-cookie"] = response.cookies.map(formatCookie);
	outgoing.writeHead(response.status ?? 200, headers);
	outgoing.end(response.body ?? "");
}

async function readBody(incoming: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of incoming) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseCookies(header: string | undefined): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const part of header?.split(";") ?? []) {
		const eq = part.indexOf("=");
		if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
	}
	return cookies;
}

function formatCookie(cookie: SetCookie): string {
	const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`, "Path=/", "SameSite=Lax"];
	if (cookie.maxAge !== undefined) parts.push(`Max-Age=${cookie.maxAge}`);
	if (cookie.httpOnly !== false) parts.push("HttpOnly");
	return parts.join("; ");
}

export function html(body: string, init: Omit<SiteResponse, "body"> = {}): SiteResponse {
	return { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers }, body };
}

export function json(value: unknown, init: Omit<SiteResponse, "body"> = {}): SiteResponse {
	return { ...init, headers: { "content-type": "application/json", ...init.headers }, body: JSON.stringify(value) };
}

export function text(body: string, init: Omit<SiteResponse, "body"> = {}): SiteResponse {
	return { ...init, headers: { "content-type": "text/plain; charset=utf-8", ...init.headers }, body };
}

/** A 303, so a form post lands on a page a reload does not post again. */
export function redirect(location: string, init: Omit<SiteResponse, "body" | "status"> = {}): SiteResponse {
	return { ...init, status: 303, headers: { location, ...init.headers } };
}

/** The fields of a urlencoded form body; a repeated field keeps every value, joined by commas. */
export function formFields(request: SiteRequest): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const [name, value] of new URLSearchParams(request.body)) {
		fields[name] = name in fields ? `${fields[name]},${value}` : value;
	}
	return fields;
}

/** The request's JSON body, or null when it has none or it does not parse. */
export function jsonBody(request: SiteRequest): unknown {
	if (!request.body) return null;
	try {
		return JSON.parse(request.body);
	} catch {
		return null;
	}
}

/** Escape text for an HTML body or attribute. */
export function escapeHtml(value: string | number): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

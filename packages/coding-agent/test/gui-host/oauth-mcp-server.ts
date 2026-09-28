/**
 * A remote MCP server behind an OAuth authorization server, both on one
 * loopback HTTP listener. `/mcp` answers JSON-RPC only for a bearer token the
 * `/token` endpoint issued and has not revoked; any other request is refused
 * with 401 and a `WWW-Authenticate` challenge naming the protected-resource
 * metadata, which is how a real server tells a client to log in. The
 * authorization server advertises dynamic client registration, so a login
 * needs no client id configured in advance.
 *
 * Nothing serves `/authorize`: a test completes a login by pasting the
 * redirect a browser would have followed, `<redirect_uri>?code=…&state=…`.
 */
import * as http from "node:http";

export const OAUTH_SERVER_INFO = { name: "oauth-fixture", version: "3.1.0" };
export const OAUTH_TOOL = "whoami";

export interface OAuthMcpServer {
	/** The MCP endpoint a config points at. */
	url: string;
	/** Every authorization code `/token` exchanged, oldest first. */
	exchanged: readonly string[];
	/** Every access token `/token` issued, oldest first. */
	issued: readonly string[];
	/** Stop honoring every token issued so far. */
	revokeAll(): void;
	close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function rpcResult(method: string): Record<string, unknown> {
	if (method === "initialize") {
		return { protocolVersion: "2025-03-26", serverInfo: OAUTH_SERVER_INFO, capabilities: { tools: {} } };
	}
	if (method === "tools/list") {
		return { tools: [{ name: OAUTH_TOOL, description: "Names the caller", inputSchema: { type: "object" } }] };
	}
	return {};
}

async function answerMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	if (req.method === "GET") {
		res.writeHead(405).end();
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(200).end();
		return;
	}
	let message: unknown;
	try {
		message = JSON.parse(await readBody(req));
	} catch {
		sendJson(res, 400, { error: "invalid json" });
		return;
	}
	if (typeof message !== "object" || message === null || !("method" in message) || !("id" in message)) {
		res.writeHead(202).end();
		return;
	}
	const { id, method } = message;
	sendJson(res, 200, { jsonrpc: "2.0", id, result: rpcResult(typeof method === "string" ? method : "") });
}

/** Start the fixture. `open` answers `/mcp` without a token, as a server that needs no login does. */
export async function startOAuthMcpServer(options: { open?: boolean } = {}): Promise<OAuthMcpServer> {
	const issued: string[] = [];
	const exchanged: string[] = [];
	const honored = new Set<string>();
	let origin = "";

	const server = http.createServer((req, res) => {
		void (async () => {
			const route = new URL(req.url ?? "/", origin).pathname;
			if (route.startsWith("/.well-known/oauth-protected-resource")) {
				sendJson(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
				return;
			}
			if (route === "/.well-known/oauth-authorization-server") {
				sendJson(res, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (route === "/register" && req.method === "POST") {
				await readBody(req);
				sendJson(res, 201, { client_id: "desktop-fixture-client" });
				return;
			}
			if (route === "/token" && req.method === "POST") {
				const form = new URLSearchParams(await readBody(req));
				const code = form.get("code");
				if (form.get("grant_type") !== "authorization_code" || !code) {
					sendJson(res, 400, { error: "invalid_grant" });
					return;
				}
				exchanged.push(code);
				const token = `access-${issued.length + 1}`;
				issued.push(token);
				honored.add(token);
				sendJson(res, 200, {
					access_token: token,
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "refresh",
				});
				return;
			}
			if (route === "/mcp") {
				const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
				if (!options.open && (!bearer || !honored.has(bearer))) {
					await readBody(req);
					res.writeHead(401, {
						"Content-Type": "application/json",
						"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
					});
					res.end(JSON.stringify({ error: "invalid_token" }));
					return;
				}
				await answerMcp(req, res);
				return;
			}
			res.writeHead(404).end();
		})();
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("the OAuth MCP fixture bound no TCP port");
	origin = `http://127.0.0.1:${address.port}`;

	return {
		url: `${origin}/mcp`,
		exchanged,
		issued,
		revokeAll: () => honored.clear(),
		close: async () => {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

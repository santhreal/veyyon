const MAX_BODY_BYTES = 256 * 1024;
const MAX_ENTRIES = 50;

const LIMITS = {
	agentVersion: 64,
	installId: 128,
	platform: 32,
	arch: 32,
	model: 256,
	entryVersion: 64,
	tool: 128,
	report: 4096,
} as const;

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SqlValue = string | number;

interface D1BatchResult {
	success: boolean;
}

interface D1PreparedStatement {
	bind(...values: SqlValue[]): D1PreparedStatement;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
	batch(statements: D1PreparedStatement[]): Promise<D1BatchResult[]>;
}

interface Env {
	GRIEVANCES_DB: D1Database;
}

interface PagesContext {
	request: Request;
	env: Env;
}

interface GrievanceEntry {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

interface GrievanceBatch {
	agent: {
		name: "veyyon";
		version: string;
	};
	installId: string;
	platform: string;
	arch: string;
	entries: GrievanceEntry[];
}

type BodyReadResult =
	| { ok: true; text: string }
	| { ok: false; status: 400 | 413; error: string };

const INSERT_GRIEVANCE = `
INSERT INTO grievances (
	install_id,
	local_id,
	agent_version,
	model,
	entry_version,
	tool,
	report,
	platform,
	arch,
	received_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (install_id, local_id) DO NOTHING
`;

function json(status: number, body: Readonly<Record<string, string | number>>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function error(status: number, message: string, headers?: HeadersInit): Response {
	const response = json(status, { error: message });
	if (headers) {
		for (const [name, value] of new Headers(headers)) response.headers.set(name, value);
	}
	return response;
}


async function readBoundedBody(request: Request): Promise<BodyReadResult> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		if (!/^\d+$/.test(declaredLength)) return { ok: false, status: 400, error: "Invalid Content-Length" };
		if (Number(declaredLength) > MAX_BODY_BYTES) {
			return { ok: false, status: 413, error: "Request body is too large" };
		}
	}

	if (request.body === null) return { ok: false, status: 400, error: "Request body is required" };

	const reader = request.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const parts: string[] = [];
	let bytesRead = 0;

	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytesRead += chunk.value.byteLength;
			if (bytesRead > MAX_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, status: 413, error: "Request body is too large" };
			}
			parts.push(decoder.decode(chunk.value, { stream: true }));
		}
		parts.push(decoder.decode());
	} catch {
		return { ok: false, status: 400, error: "Request body could not be read" };
	}

	if (bytesRead === 0) return { ok: false, status: 400, error: "Request body is required" };
	return { ok: true, text: parts.join("") };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function validateEntry(value: unknown): value is GrievanceEntry {
	if (!isObject(value) || !hasExactKeys(value, ["id", "model", "version", "tool", "report"])) return false;
	return (
		typeof value.id === "number" &&
		Number.isSafeInteger(value.id) &&
		value.id > 0 &&
		isBoundedString(value.model, LIMITS.model) &&
		isBoundedString(value.version, LIMITS.entryVersion) &&
		isBoundedString(value.tool, LIMITS.tool) &&
		isBoundedString(value.report, LIMITS.report)
	);
}

function validateBatch(value: unknown): value is GrievanceBatch {
	if (!isObject(value) || !hasExactKeys(value, ["agent", "installId", "platform", "arch", "entries"])) {
		return false;
	}
	if (!isObject(value.agent) || !hasExactKeys(value.agent, ["name", "version"])) return false;
	if (value.agent.name !== "veyyon" || !isBoundedString(value.agent.version, LIMITS.agentVersion)) return false;
	if (!isBoundedString(value.installId, LIMITS.installId) || !INSTALL_ID_PATTERN.test(value.installId)) return false;
	if (!isBoundedString(value.platform, LIMITS.platform)) return false;
	if (!isBoundedString(value.arch, LIMITS.arch)) return false;
	if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_ENTRIES) return false;
	return value.entries.every(validateEntry);
}

export async function onRequest(context: PagesContext): Promise<Response> {
	if (context.request.method !== "POST") return error(405, "Method not allowed", { allow: "POST" });
	if (context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		return error(415, "Content-Type must be application/json");
	}

	const body = await readBoundedBody(context.request);
	if (!body.ok) return error(body.status, body.error);

	let parsed: unknown;
	try {
		parsed = JSON.parse(body.text) as unknown;
	} catch {
		return error(400, "Malformed JSON");
	}
	if (!validateBatch(parsed)) return error(422, "Invalid grievance batch");

	const receivedAt = new Date().toISOString();
	try {
		const statements = parsed.entries.map(entry =>
			context.env.GRIEVANCES_DB.prepare(INSERT_GRIEVANCE).bind(
				parsed.installId,
				entry.id,
				parsed.agent.version,
				entry.model,
				entry.version,
				entry.tool,
				entry.report,
				parsed.platform,
				parsed.arch,
				receivedAt,
			),
		);
		const results = await context.env.GRIEVANCES_DB.batch(statements);
		if (results.length !== statements.length || results.some(result => !result.success)) {
			return error(500, "Failed to persist grievance batch");
		}
	} catch {
		return error(500, "Failed to persist grievance batch");
	}

	return json(202, { accepted: parsed.entries.length });
}

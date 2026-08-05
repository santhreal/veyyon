import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@veyyon/utils";
import { getAgentDir } from "@veyyon/utils/dirs";
import { smitheryTimeoutSignal } from "./smithery-http";

const SMITHERY_AUTH_FILENAME = "smithery.json";
const SMITHERY_URL = process.env.SMITHERY_URL || "https://smithery.ai";

type SmitheryCliAuthSession = {
	sessionId: string;
	authUrl: string;
};

type SmitheryCliPollResponse = {
	status: "pending" | "success" | "error";
	apiKey?: string;
	message?: string;
};

type SmitheryAuthPayload = {
	apiKey?: string;
};

function getSmitheryAuthPath(): string {
	return path.join(getAgentDir(), SMITHERY_AUTH_FILENAME);
}

function normalizeApiKey(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getSmitheryLoginUrl(): string {
	return SMITHERY_URL;
}

export async function createSmitheryCliAuthSession(): Promise<SmitheryCliAuthSession> {
	const response = await fetch(`${SMITHERY_URL}/api/auth/cli/session`, {
		method: "POST",
		signal: smitheryTimeoutSignal(),
	});
	if (!response.ok) {
		throw new Error(
			`Smithery would not start a login session: HTTP ${response.status} ${response.statusText} from ${SMITHERY_URL}/api/auth/cli/session. Fix: check that ${SMITHERY_URL} is reachable from this network, then run \`/mcp smithery-login\` again. If you already hold a key, set \`SMITHERY_API_KEY\` in the environment instead and skip the login.`,
		);
	}
	return (await response.json()) as SmitheryCliAuthSession;
}

export async function pollSmitheryCliAuthSession(
	sessionId: string,
	signal?: AbortSignal,
): Promise<SmitheryCliPollResponse> {
	const response = await fetch(`${SMITHERY_URL}/api/auth/cli/poll/${sessionId}`, {
		signal,
	});
	if (!response.ok) {
		if (response.status === 404 || response.status === 410) {
			throw new Error(
				`This Smithery login session expired before it was approved in the browser. Fix: run \`/mcp smithery-login\` again and finish the approval in the browser page it opens.`,
			);
		}
		throw new Error(
			`Smithery would not report the state of this login session: HTTP ${response.status} ${response.statusText}. Fix: run \`/mcp smithery-login\` again. If ${SMITHERY_URL} is unreachable from this network, set \`SMITHERY_API_KEY\` in the environment instead and skip the login.`,
		);
	}
	return (await response.json()) as SmitheryCliPollResponse;
}

export async function getSmitheryApiKey(): Promise<string | undefined> {
	const envKey = normalizeApiKey(process.env.SMITHERY_API_KEY);
	if (envKey) return envKey;

	const authPath = getSmitheryAuthPath();
	try {
		const payload = (await Bun.file(authPath).json()) as SmitheryAuthPayload;
		return normalizeApiKey(payload.apiKey);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("Failed to read Smithery auth file, treating as missing", { path: authPath, error });
		return undefined;
	}
}

export async function saveSmitheryApiKey(apiKey: string): Promise<void> {
	const normalized = normalizeApiKey(apiKey);
	if (!normalized) {
		throw new Error(
			"A Smithery API key cannot be empty. Fix: paste the key from your Smithery account settings, or run `/mcp smithery-login` to obtain one through the browser.",
		);
	}

	const authPath = getSmitheryAuthPath();
	const payload: SmitheryAuthPayload = { apiKey: normalized };
	await Bun.write(authPath, `${JSON.stringify(payload, null, 2)}\n`);
	try {
		await fs.chmod(authPath, 0o600);
	} catch (error) {
		logger.warn("Could not set restrictive permissions on Smithery auth file", { path: authPath, error });
	}
}

export async function clearSmitheryApiKey(): Promise<boolean> {
	const authPath = getSmitheryAuthPath();
	try {
		await fs.rm(authPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

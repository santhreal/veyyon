import { trimTrailingSlashes } from "@veyyon/utils";
import { smitheryTimeoutSignal } from "./smithery-http";

const SMITHERY_API_BASE_URL = trimTrailingSlashes(process.env.SMITHERY_API_URL || "https://api.smithery.ai");

export class SmitheryConnectError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryConnectError";
		this.status = status;
	}
}

type SmitheryNamespace = {
	name: string;
};

type SmitheryNamespacesResponse = {
	namespaces?: SmitheryNamespace[];
};

type SmitheryConnectionStatus =
	| { state: "connected" }
	| { state: "auth_required"; authorizationUrl?: string }
	| { state: "error"; message: string }
	| { state: string; [key: string]: unknown };

export type SmitheryConnection = {
	connectionId: string;
	mcpUrl: string;
	name: string;
	status?: SmitheryConnectionStatus;
	createdAt?: string;
};

function buildAuthHeaders(apiKey: string): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("Content-Type", "application/json");
	return headers;
}

function toApiUrl(path: string): string {
	return `${SMITHERY_API_BASE_URL}${path}`;
}

async function expectOk(response: Response, context: string): Promise<void> {
	if (response.ok) return;
	// The non-ok STATUS is the failure and it is in the thrown message with its status text; the body is extra
	// context, so a body that cannot be read just leaves the message without it.
	const responseText = await response.text().catch(() => "");
	const suffix = responseText ? `: ${responseText}` : "";
	throw new SmitheryConnectError(`${context}: ${response.status} ${response.statusText}${suffix}`, response.status);
}

export async function listSmitheryNamespaces(apiKey: string): Promise<SmitheryNamespace[]> {
	const response = await fetch(toApiUrl("/namespaces"), {
		headers: buildAuthHeaders(apiKey),
		signal: smitheryTimeoutSignal(),
	});
	await expectOk(response, "Failed to list Smithery namespaces");
	const payload = (await response.json()) as SmitheryNamespacesResponse;
	return payload.namespaces ?? [];
}

export async function createSmitheryNamespace(apiKey: string): Promise<SmitheryNamespace> {
	const response = await fetch(toApiUrl("/namespaces"), {
		method: "POST",
		headers: buildAuthHeaders(apiKey),
		signal: smitheryTimeoutSignal(),
	});
	await expectOk(response, "Failed to create Smithery namespace");
	return (await response.json()) as SmitheryNamespace;
}

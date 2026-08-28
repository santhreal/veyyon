import { toNumber } from "@veyyon/catalog/utils";
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";
import { normalizeCodexBaseUrl } from "./openai-codex-base-url";

const RESET_CREDITS_PATH = "wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_PATH = "wham/rate-limit-reset-credits/consume";

export interface CodexResetCredit {
	id: string;
	resetType?: string;
	status?: string;
	grantedAt?: string;
	expiresAt?: string;
	redeemStartedAt?: string | null;
	redeemedAt?: string | null;
	title?: string;
	description?: string;
}

export interface CodexResetCreditList {
	credits: CodexResetCredit[];
	availableCount: number;
}

export type CodexResetConsumeCode = "reset" | "already_redeemed" | "no_credit" | "nothing_to_reset" | (string & {});

export interface CodexResetConsumeResult {
	ok: boolean;
	code: CodexResetConsumeCode;
	status: number;
	raw?: unknown;
}

interface CodexResetAuth {
	accessToken: string;
	accountId?: string;
	baseUrl?: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
}

function buildUrl(baseUrl: string | undefined, routePath: string): string {
	const base = normalizeCodexBaseUrl(baseUrl);
	const normalized = base.endsWith("/") ? base : `${base}/`;
	return `${normalized}${routePath}`;
}

function buildHeaders(auth: CodexResetAuth, json: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.accessToken}`,
		"User-Agent": "OpenCode-Status-Plugin/1.0",
	};
	if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
	if (json) headers["Content-Type"] = "application/json";
	return headers;
}

function parseCredit(value: unknown): CodexResetCredit | null {
	if (!isRecord(value)) return null;
	const id = typeof value.id === "string" ? value.id : undefined;
	if (!id) return null;
	const str = (key: string): string | undefined =>
		typeof value[key] === "string" ? (value[key] as string) : undefined;
	const nullableStr = (key: string): string | null | undefined => {
		const raw = value[key];
		if (raw === null) return null;
		return typeof raw === "string" ? raw : undefined;
	};
	return {
		id,
		resetType: str("reset_type"),
		status: str("status"),
		grantedAt: str("granted_at"),
		expiresAt: str("expires_at"),
		redeemStartedAt: nullableStr("redeem_started_at"),
		redeemedAt: nullableStr("redeemed_at"),
		title: str("title"),
		description: str("description"),
	};
}

export async function listCodexResetCredits(auth: CodexResetAuth): Promise<CodexResetCreditList | null> {
	const url = buildUrl(auth.baseUrl, RESET_CREDITS_PATH);
	let payload: unknown;
	try {
		const response = await auth.fetch(url, { headers: buildHeaders(auth, false), signal: auth.signal });
		if (!response.ok) return null;
		payload = await response.json();
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;
	const credits = Array.isArray(payload.credits)
		? payload.credits.map(parseCredit).filter((c): c is CodexResetCredit => c !== null)
		: [];
	const reported = toNumber(payload.available_count);
	const availableCount =
		reported !== undefined
			? Math.max(0, Math.trunc(reported))
			: credits.filter(c => (c.status ?? "available") === "available").length;
	return { credits, availableCount };
}

export async function consumeCodexResetCredit(
	auth: CodexResetAuth & { creditId: string; redeemRequestId?: string },
): Promise<CodexResetConsumeResult> {
	const redeemRequestId = auth.redeemRequestId ?? crypto.randomUUID();
	const url = buildUrl(auth.baseUrl, RESET_CREDITS_CONSUME_PATH);
	const response = await auth.fetch(url, {
		method: "POST",
		headers: buildHeaders(auth, true),
		body: JSON.stringify({
			credit_id: auth.creditId,
			redeem_request_id: redeemRequestId,
			account_id: auth.accountId,
		}),
		signal: auth.signal,
	});
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const code =
		isRecord(body) && typeof body.code === "string" ? body.code : response.ok ? "reset" : `http_${response.status}`;
	return { ok: code === "reset", code, status: response.status, raw: body };
}

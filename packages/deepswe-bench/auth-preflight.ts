export interface CredentialLimit {
	readonly id: string;
	readonly status?: string;
	readonly window?: { readonly resetsAt?: number };
}

export interface CredentialProbe {
	readonly provider: string;
	readonly ok: boolean | null;
	readonly reason?: string;
	readonly email?: string;
	readonly report?: { readonly limits?: readonly CredentialLimit[] };
}

export type AuthPreflightVerdict =
	| { readonly kind: "ok"; readonly usable: number }
	| { readonly kind: "empty" }
	| { readonly kind: "dead"; readonly failures: readonly { provider: string; reason: string }[] }
	| { readonly kind: "unverifiable"; readonly providers: readonly string[] };

export function decideAuthPreflight(probes: readonly CredentialProbe[]): AuthPreflightVerdict {
	if (probes.length === 0) return { kind: "empty" };

	const usable = probes.filter(probe => probe.ok === true).length;
	if (usable > 0) return { kind: "ok", usable };

	const failures = probes
		.filter(probe => probe.ok === false)
		.map(probe => ({
			provider: probe.email ? `${probe.provider} (${probe.email})` : probe.provider,
			reason: probe.reason ?? "no reason reported",
		}));
	if (failures.length > 0) return { kind: "dead", failures };

	return { kind: "unverifiable", providers: [...new Set(probes.map(probe => probe.provider))] };
}

export function modelVendor(modelId: string): string | null {
	const id = modelId.toLowerCase();
	if (id.includes("gemini")) return "google";
	if (id.includes("claude")) return "anthropic";
	if (id.includes("gpt") || id.includes("codex") || /\bo[134]\b/.test(id)) return "openai";
	return null;
}

export function exhaustedPoolFor(
	probes: readonly CredentialProbe[],
	modelId: string,
): { pool: string; resetsAt?: number } | null {
	const provider = modelId.includes("/") ? (modelId.split("/")[0] as string) : null;
	const vendor = modelVendor(modelId);
	if (!vendor) return null;
	for (const probe of probes) {
		if (provider && probe.provider !== provider) continue;
		for (const limit of probe.report?.limits ?? []) {
			if (limit.status !== "exhausted") continue;
			if (!limit.id.toLowerCase().includes(vendor)) continue;
			const resetsAt = limit.window?.resetsAt;
			return { pool: limit.id, ...(resetsAt !== undefined && { resetsAt }) };
		}
	}
	return null;
}

export function describeExhaustedPool(pool: { pool: string; resetsAt?: number }, modelId: string): string {
	const when = pool.resetsAt ? ` It refills at ${new Date(pool.resetsAt).toISOString()}.` : "";
	return (
		`the quota pool "${pool.pool}" that "${modelId}" draws from is already spent.${when}\n` +
		"Every trial would fail with RESOURCE_EXHAUSTED and produce no tokens, leaving a run whose " +
		"missing samples look like data. Wait for the refill, or pass --model for a vendor with quota " +
		"left: a gateway provider meters each upstream vendor separately, so the others may be untouched. " +
		"This is a quota problem. The model id and the arm allowlists are not at fault."
	);
}

export function describeAuthPreflightFailure(verdict: AuthPreflightVerdict, stagedPath: string): string {
	switch (verdict.kind) {
		case "empty":
			return (
				`the staged auth DB holds no credentials: ${stagedPath}\n` +
				"re-seed it by logging in (vey, then /login), which writes ~/.veyyon/shared-auth/agent.db"
			);
		case "dead": {
			const lines = verdict.failures.map(failure => `  ${failure.provider}: ${failure.reason}`).join("\n");
			return (
				`the staged auth DB cannot serve a token: ${stagedPath}\n${lines}\n` +
				"re-seed it by logging in again (vey, then /login). This is a credential problem. " +
				"The model id and the arm allowlists are not at fault; do not change them."
			);
		}
		default:
			return "";
	}
}

export function spentQuotaShouldAbort(spent: { pool: string } | null, dryRun: boolean): boolean {
	if (spent === null) return false;
	return !dryRun;
}

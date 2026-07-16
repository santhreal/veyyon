/**
 * ArkType schemas for the auth-broker wire protocol.
 *
 * Shared between the server (validates inbound request bodies) and the client
 * (validates responses from the broker). Schemas mirror the TypeScript types
 * in `./types.ts` 1:1; the types remain the source of truth for static typing,
 * and `Type` is asserted-compatible with them where possible.
 *
 * Envelope and fixed-shape schemas use `"+": "reject"` so unknown keys are
 * rejected — the previous implementation used a hand-rolled `hasOnlyFields`
 * allowlist for the same effect. The OAuth credential schema is the deliberate
 * exception (standard type keeps extra keys): it preserves provider-specific extension fields so
 * they round-trip through the broker instead of being dropped (see below).
 *
 * Construction is deferred behind {@link wireSchemas}: building this many
 * ArkType types costs ~18ms, which only broker request/response paths ever
 * need — the boot path must not pay it.
 */
import { type } from "arktype";
import { REMOTE_REFRESH_SENTINEL } from "../auth-storage";

function buildWireSchemas() {
	// ─── Credential payloads ─────────────────────────────────────────────────

	/** Real OAuth credential (broker-side) — refresh token is the actual upstream value. */
	const oauthCredentialSchema = type({
		"apiEndpoint?": "string",
		type: "'oauth'",
		refresh: type("string").narrow(
			(value, ctx) =>
				value !== REMOTE_REFRESH_SENTINEL ||
				ctx.mustBe(`not equal to the remote sentinel (${REMOTE_REFRESH_SENTINEL})`),
		),
		access: type("string").atLeastLength(1),
		expires: "number",
		"enterpriseUrl?": "string",
		"projectId?": "string",
		"email?": "string",
		"accountId?": "string",
		"orgId?": "string",
		"orgName?": "string",
	});

	/** OAuth credential as it appears in broker snapshots — refresh replaced with sentinel. */
	const remoteOauthCredentialSchema = type({
		"apiEndpoint?": "string",
		type: "'oauth'",
		refresh: type.enumerated(REMOTE_REFRESH_SENTINEL),
		access: type("string").atLeastLength(1),
		expires: "number",
		"enterpriseUrl?": "string",
		"projectId?": "string",
		"email?": "string",
		"accountId?": "string",
		"orgId?": "string",
		"orgName?": "string",
	});

	const apiKeyCredentialSchema = type({
		"+": "reject",
		type: "'api_key'",
		key: type("string").atLeastLength(1),
	});

	/** Discriminated union accepted on POST /v1/credential (writes). */
	const writableAuthCredentialSchema = oauthCredentialSchema.or(apiKeyCredentialSchema);

	/** Discriminated union returned in snapshots (refresh is sentinel for OAuth). */
	const snapshotCredentialSchema = remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

	// ─── Snapshot ────────────────────────────────────────────────────────────

	const credentialSnapshotEntrySchema = type({
		"+": "reject",
		id: "number.integer",
		provider: type("string").atLeastLength(1),
		credential: snapshotCredentialSchema,
		identityKey: "string | null",
	});

	const credentialBlockSnapshotSchema = type({
		"+": "reject",
		providerKey: type("string").atLeastLength(1),
		blockScope: "string",
		blockedUntilMs: "number",
		"updatedAtMs?": "number",
	});

	const snapshotEntrySchema = type({
		"+": "reject",
		id: "number.integer",
		provider: type("string").atLeastLength(1),
		credential: snapshotCredentialSchema,
		identityKey: "string | null",
		rotatesInMs: "number | null",
		"blocks?": credentialBlockSnapshotSchema.array(),
	});

	const refresherScheduleSchema = type({
		"+": "reject",
		enabled: "boolean",
		intervalMs: "number",
		skewMs: "number",
		nextSweepInMs: "number",
	});

	const snapshotResponseSchema = type({
		"+": "reject",
		generation: "number.integer",
		generatedAt: "number",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		credentials: snapshotEntrySchema.array(),
	});

	// ─── Snapshot stream (SSE) ───────────────────────────────────────────────

	/** First frame on connect — full snapshot embedded inline with a `kind` tag. */
	const snapshotStreamSnapshotEventSchema = type({
		"+": "reject",
		generation: "number.integer",
		generatedAt: "number",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		credentials: snapshotEntrySchema.array(),
		kind: "'snapshot'",
	});

	/** Per-credential upsert/refresh delta. */
	const snapshotStreamEntryEventSchema = type({
		"+": "reject",
		kind: "'entry'",
		generation: "number.integer",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		entry: snapshotEntrySchema,
	});

	/** Per-credential delete delta. */
	const snapshotStreamRemovedEventSchema = type({
		"+": "reject",
		kind: "'removed'",
		generation: "number.integer",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		id: "number.integer",
	});

	/** Discriminated union over every event frame the snapshot stream emits. */
	const snapshotStreamEventSchema = snapshotStreamSnapshotEventSchema
		.or(snapshotStreamEntryEventSchema)
		.or(snapshotStreamRemovedEventSchema);

	// ─── Healthz ─────────────────────────────────────────────────────────────

	const healthzResponseSchema = type({
		"+": "reject",
		ok: "boolean",
		"version?": "string",
	});

	// ─── Usage ───────────────────────────────────────────────────────────────

	const usageUnitSchema = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
	const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

	const usageWindowSchema = type({
		id: "string",
		label: "string",
		"durationMs?": "number",
		"resetsAt?": "number",
	});

	const usageAmountSchema = type({
		"used?": "number",
		"limit?": "number",
		"remaining?": "number",
		"usedFraction?": "number",
		"remainingFraction?": "number",
		unit: usageUnitSchema,
	});

	const usageScopeSchema = type({
		provider: "string",
		"accountId?": "string",
		"projectId?": "string",
		"orgId?": "string",
		"modelId?": "string",
		"tier?": "string",
		"windowId?": "string",
		"shared?": "boolean",
	});

	const usageLimitSchema = type({
		id: "string",
		label: "string",
		scope: usageScopeSchema,
		"window?": usageWindowSchema,
		amount: usageAmountSchema,
		"status?": usageStatusSchema,
		"notes?": "string[]",
	});

	const usageResetCreditDetailSchema = type({
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	});

	const usageResetCreditsSchema = type({
		availableCount: "number",
		"credits?": usageResetCreditDetailSchema.array(),
	});

	const arkUsageReportSchema = type({
		provider: "string",
		fetchedAt: "number",
		limits: usageLimitSchema.array(),
		"resetCredits?": usageResetCreditsSchema,
		"notes?": "string[]",
		"metadata?": { "[string]": "unknown" },
		"raw?": "unknown",
	});

	/**
	 * Broker `/v1/usage` response. Reports are full UsageReports minus the
	 * heavy provider-specific `raw` field (the server strips it before send) — we
	 * keep `raw` optional in the underlying schema so a misconfigured broker that
	 * forgot to strip still validates.
	 */
	const usageResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		reports: arkUsageReportSchema.array(),
	});

	// ─── Refresh ─────────────────────────────────────────────────────────────

	const credentialRefreshResponseSchema = type({
		"+": "reject",
		entry: credentialSnapshotEntrySchema,
	});

	// ─── Disable ─────────────────────────────────────────────────────────────

	const credentialDisableRequestSchema = type({
		"+": "reject",
		"cause?": "string",
	});

	const credentialDisableResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	// ─── Credential blocks ───────────────────────────────────────────────────

	const credentialBlockRequestSchema = credentialBlockSnapshotSchema;

	const credentialBlockResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	const credentialBlocksDeleteResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	const usageStaleResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	// ─── Upload ──────────────────────────────────────────────────────────────

	const credentialUploadRequestSchema = type({
		"+": "reject",
		provider: type("string").atLeastLength(1),
		credential: writableAuthCredentialSchema,
	});

	const credentialUploadResponseSchema = type({
		"+": "reject",
		entries: credentialSnapshotEntrySchema.array(),
	});

	return {
		oauthCredentialSchema,
		remoteOauthCredentialSchema,
		apiKeyCredentialSchema,
		writableAuthCredentialSchema,
		snapshotCredentialSchema,
		credentialSnapshotEntrySchema,
		credentialBlockSnapshotSchema,
		snapshotEntrySchema,
		refresherScheduleSchema,
		snapshotResponseSchema,
		snapshotStreamSnapshotEventSchema,
		snapshotStreamEntryEventSchema,
		snapshotStreamRemovedEventSchema,
		snapshotStreamEventSchema,
		healthzResponseSchema,
		usageResponseSchema,
		credentialRefreshResponseSchema,
		credentialDisableRequestSchema,
		credentialDisableResponseSchema,
		credentialBlockRequestSchema,
		credentialBlockResponseSchema,
		credentialBlocksDeleteResponseSchema,
		usageStaleResponseSchema,
		credentialUploadRequestSchema,
		credentialUploadResponseSchema,
	};
}

type WireSchemas = ReturnType<typeof buildWireSchemas>;

let schemasCache: WireSchemas | undefined;

/** All auth-broker wire schemas, constructed on first use. */
export function wireSchemas(): WireSchemas {
	schemasCache ??= buildWireSchemas();
	return schemasCache;
}

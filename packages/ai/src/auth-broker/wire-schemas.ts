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
import { type Type, type } from "arktype";
import { REMOTE_REFRESH_SENTINEL } from "../auth-storage";
import { usageWireSchemas } from "../usage/report-wire";
import type {
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlocksDeleteResponse,
	CredentialDisableRequest,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
	UsageResponse,
	UsageStaleResponse,
} from "./types";

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
		"source?": "'login'",
	});

	// `source` records that the key came from an interactive `/login` rather than a
	// pasted value. `exportSnapshot` spreads the stored credential, so an OAuth row
	// that carries `source` reaches the wire, and both schemas must accept it.
	const apiKeyCredentialSchema = type({
		"+": "reject",
		type: "'api_key'",
		key: type("string").atLeastLength(1),
		"source?": "'login'",
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

	// The report vocabulary has one owner. This file restated all nine schemas, identically,
	// beside the copy `usage.ts` declared at module scope: the broker's response embeds a
	// report, it is not a second definition of what a report is.
	const usage = usageWireSchemas();

	/**
	 * Broker `/v1/usage` response. Reports are full UsageReports minus the
	 * heavy provider-specific `raw` field (the server strips it before send) — we
	 * keep `raw` optional in the underlying schema so a misconfigured broker that
	 * forgot to strip still validates.
	 */
	const usageResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		reports: usage.report.array(),
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

	const schemas: WireSchemas = {
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
	return schemas;
}

export interface WireSchemas {
	oauthCredentialSchema: Type;
	remoteOauthCredentialSchema: Type;
	apiKeyCredentialSchema: Type;
	writableAuthCredentialSchema: Type;
	snapshotCredentialSchema: Type;
	credentialSnapshotEntrySchema: Type;
	credentialBlockSnapshotSchema: Type;
	snapshotEntrySchema: Type<SnapshotEntry>;
	refresherScheduleSchema: Type<RefresherSchedule>;
	snapshotResponseSchema: Type<SnapshotResponse>;
	snapshotStreamSnapshotEventSchema: Type<SnapshotStreamSnapshotEvent>;
	snapshotStreamEntryEventSchema: Type<SnapshotStreamEntryEvent>;
	snapshotStreamRemovedEventSchema: Type<SnapshotStreamRemovedEvent>;
	snapshotStreamEventSchema: Type<SnapshotStreamEvent>;
	healthzResponseSchema: Type<HealthzResponse>;
	usageResponseSchema: Type<UsageResponse>;
	credentialRefreshResponseSchema: Type<CredentialRefreshResponse>;
	credentialDisableRequestSchema: Type<CredentialDisableRequest>;
	credentialDisableResponseSchema: Type<CredentialDisableResponse>;
	credentialBlockRequestSchema: Type<CredentialBlockRequest>;
	credentialBlockResponseSchema: Type<CredentialBlockResponse>;
	credentialBlocksDeleteResponseSchema: Type<CredentialBlocksDeleteResponse>;
	usageStaleResponseSchema: Type<UsageStaleResponse>;
	credentialUploadRequestSchema: Type<CredentialUploadRequest>;
	credentialUploadResponseSchema: Type<CredentialUploadResponse>;
}

let schemasCache: WireSchemas | undefined;
/** All auth-broker wire schemas, constructed on first use. */
export function wireSchemas(): WireSchemas {
	schemasCache ??= buildWireSchemas();
	return schemasCache;
}

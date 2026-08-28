import { type } from "arktype";
import { REMOTE_REFRESH_SENTINEL } from "../auth-storage";
import { usageWireSchemas } from "../usage/report-wire";

function buildWireSchemas() {
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

	const writableAuthCredentialSchema = oauthCredentialSchema.or(apiKeyCredentialSchema);

	const snapshotCredentialSchema = remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

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

	const snapshotStreamSnapshotEventSchema = type({
		"+": "reject",
		generation: "number.integer",
		generatedAt: "number",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		credentials: snapshotEntrySchema.array(),
		kind: "'snapshot'",
	});

	const snapshotStreamEntryEventSchema = type({
		"+": "reject",
		kind: "'entry'",
		generation: "number.integer",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		entry: snapshotEntrySchema,
	});

	const snapshotStreamRemovedEventSchema = type({
		"+": "reject",
		kind: "'removed'",
		generation: "number.integer",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		id: "number.integer",
	});

	const snapshotStreamEventSchema = snapshotStreamSnapshotEventSchema
		.or(snapshotStreamEntryEventSchema)
		.or(snapshotStreamRemovedEventSchema);

	const healthzResponseSchema = type({
		"+": "reject",
		ok: "boolean",
		"version?": "string",
	});

	const usage = usageWireSchemas();

	const usageResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		reports: usage.report.array(),
	});

	const credentialRefreshResponseSchema = type({
		"+": "reject",
		entry: credentialSnapshotEntrySchema,
	});

	const credentialDisableRequestSchema = type({
		"+": "reject",
		"cause?": "string",
	});

	const credentialDisableResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

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

export function wireSchemas(): WireSchemas {
	schemasCache ??= buildWireSchemas();
	return schemasCache;
}

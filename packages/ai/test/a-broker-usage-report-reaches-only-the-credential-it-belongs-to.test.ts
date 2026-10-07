/**
 * WHY: `RemoteAuthCredentialStore` answers from broker data that covers every credential the broker
 * holds. The `/v1/usage` reports are aggregate, so the store picks the one report that belongs to a
 * credential, and merges a header-observed usage overlay into the report of the same identity. A
 * report handed to the wrong credential ranks or blocks one subscription on another's quota: a Team
 * member on a sibling's pool, an org-scoped seat on the personal plan that shares its email, a
 * legacy row on a scoped sibling's numbers. The same snapshots carry credential blocks, each held
 * for reconciliation for five minutes from its last update; a refresh that re-arms an unchanged
 * block, or misses a changed one, moves the next probe of a blocked credential.
 *
 * Every usage row runs through both entry points, `getUsageReport` and the overlay merge in
 * `fetchUsageReports`, against a real `AuthBrokerClient` on a fake broker transport, and every
 * identity field is swept through each place a report may carry it. The background loop is driven
 * against a broker without a snapshot stream.
 *
 * Not caught here: an identity field the matcher starts to read is not swept until a row names it;
 * the reconcile map dropping the deadline of a block that left the snapshot bounds memory only and
 * has no observable effect; backoff timing is left to the stale-view suite.
 */
import { afterEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { type OAuthCredential, REMOTE_REFRESH_SENTINEL } from "@veyyon/ai";
import {
	AuthBrokerClient,
	type CredentialBlockSnapshot,
	RemoteAuthCredentialStore,
	type SnapshotEntry,
	type SnapshotResponse,
} from "@veyyon/ai/auth-broker";
import type { UsageReport, UsageScope } from "@veyyon/ai/usage";
import { logger } from "@veyyon/utils";

const PROVIDER = "anthropic";
const OTHER_PROVIDER = "openai-codex";
const ACCOUNT = "acct-1";
const OTHER_ACCOUNT = "acct-2";
const ORG = "org-1";
const OTHER_ORG = "org-2";
const LONG_POLL = "GET /v1/snapshot?wait=30000";
const STREAM = "GET /v1/snapshot/stream";

type Respond = (request: string, init: RequestInit) => Response | Promise<Response>;

interface FakeBroker {
	fetchImpl: typeof fetch;
	/** `METHOD /path?query` of every request that left the client. */
	requests: string[];
	/** Resolves when the `count`-th request equal to `request` arrives. */
	arrival(request: string, count: number): Promise<void>;
}

function fakeBroker(respond: Respond): FakeBroker {
	const requests: string[] = [];
	const waiters: { request: string; count: number; resolve: () => void }[] = [];
	const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
		init.signal?.throwIfAborted();
		const url = new URL(String(input));
		const request = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
		requests.push(request);
		const seen = requests.filter(candidate => candidate === request).length;
		for (const waiter of waiters) if (waiter.request === request && waiter.count === seen) waiter.resolve();
		// A real socket answers on a later macrotask; a loop that never sleeps must not starve the test.
		await nextMacrotask();
		return respond(request, init);
	}) as typeof fetch;
	return {
		fetchImpl,
		requests,
		arrival(request, count) {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (requests.filter(candidate => candidate === request).length >= count) resolve();
			else waiters.push({ request, count, resolve });
			return promise;
		},
	};
}

/** A long-poll that holds until the store shuts down, as a broker with nothing new does. */
function holdUntilAborted(init: RequestInit): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	const signal = init.signal;
	if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	return promise;
}

function snapshotResponse(generation: number, credentials: SnapshotEntry[]): SnapshotResponse {
	return {
		generation,
		generatedAt: 0,
		serverNowMs: Date.now(),
		refresher: { enabled: false, intervalMs: 60_000, skewMs: 300_000, nextSweepInMs: 0 },
		credentials,
	};
}

function entry(id: number, blocks?: CredentialBlockSnapshot[]): SnapshotEntry {
	return {
		id,
		provider: PROVIDER,
		credential: { type: "oauth", access: `access-${id}`, refresh: REMOTE_REFRESH_SENTINEL, expires: 0 },
		identityKey: null,
		rotatesInMs: null,
		...(blocks ? { blocks } : {}),
	};
}

const stores: RemoteAuthCredentialStore[] = [];

function openStore(
	broker: FakeBroker,
	opts: { initialSnapshot?: SnapshotResponse; streamSnapshots?: boolean } = {},
): RemoteAuthCredentialStore {
	const client = new AuthBrokerClient({ url: "http://broker.test", token: "bearer", fetchImpl: broker.fetchImpl });
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot: opts.initialSnapshot ?? snapshotResponse(1, []),
		streamSnapshots: opts.streamSnapshots ?? false,
	});
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	setSystemTime();
	vi.restoreAllMocks();
});

interface Identity {
	orgId?: string;
	accountId?: string;
	email?: string;
	projectId?: string;
}

interface ReportSpec {
	provider?: string;
	metadata?: Record<string, unknown>;
	scope?: Partial<UsageScope>;
}

interface UsageRow {
	name: string;
	reports: ReportSpec[];
	credential: Identity;
	/** Index of the report that belongs to the credential, or `null` for none. */
	expected: number | null;
}

/**
 * Where a report may carry each base identity field: its own metadata key, the alias read when that
 * key holds no value, and whether a limit's scope may carry it.
 */
const IDENTITY_FIELDS: { field: "accountId" | "email" | "projectId"; alias?: string; inScope: boolean }[] = [
	{ field: "accountId", alias: "account_id", inScope: true },
	{ field: "email", inScope: false },
	{ field: "projectId", alias: "project_id", inScope: true },
];

const VALUE = { accountId: ACCOUNT, email: "member@example.com", projectId: "proj-1" };
const OTHER_VALUE = { accountId: OTHER_ACCOUNT, email: "other@example.com", projectId: "proj-2" };

function identityFieldRows(): UsageRow[] {
	const rows: UsageRow[] = [];
	for (const { field, alias, inScope } of IDENTITY_FIELDS) {
		const credential = { [field]: VALUE[field] };
		// A decoy org-less report keeps the lone-report fallback out of every row.
		const decoy: ReportSpec = { metadata: { [field]: OTHER_VALUE[field] } };
		rows.push(
			{
				name: `${field} in metadata`,
				reports: [decoy, { metadata: { [field]: VALUE[field] } }],
				credential,
				expected: 1,
			},
			{
				name: `${field} in metadata, folded for case and padding`,
				reports: [decoy, { metadata: { [field]: ` ${VALUE[field].toUpperCase()} ` } }],
				credential: { [field]: ` ${VALUE[field].toUpperCase()} ` },
				expected: 1,
			},
			{
				name: `${field} that names another value`,
				reports: [decoy, { metadata: { [field]: OTHER_VALUE[field] } }],
				credential,
				expected: null,
			},
		);
		if (alias) {
			rows.push(
				{
					name: `${field} under ${alias}`,
					reports: [decoy, { metadata: { [alias]: VALUE[field] } }],
					credential,
					expected: 1,
				},
				{
					name: `${field} under ${alias} behind a blank ${field}`,
					reports: [decoy, { metadata: { [field]: "  ", [alias]: VALUE[field] } }],
					credential,
					expected: 1,
				},
				{
					name: `${alias} behind a ${field} that names another value`,
					reports: [decoy, { metadata: { [field]: OTHER_VALUE[field], [alias]: VALUE[field] } }],
					credential,
					expected: null,
				},
			);
		}
		if (inScope) {
			rows.push({
				name: `${field} in a limit scope, folded for case`,
				reports: [decoy, { scope: { [field]: VALUE[field].toUpperCase() } }],
				credential,
				expected: 1,
			});
		}
	}
	return rows;
}

const USAGE_ROWS: UsageRow[] = [
	{
		name: "an org-scoped credential takes its own member's report in its org",
		reports: [
			{ metadata: { orgId: ORG, accountId: OTHER_ACCOUNT } },
			{ metadata: { orgId: ORG, accountId: ACCOUNT } },
		],
		credential: { orgId: ORG, accountId: ACCOUNT },
		expected: 1,
	},
	{
		name: "an org-scoped credential does not take a sibling member's lone report in its org",
		reports: [{ metadata: { orgId: ORG, accountId: OTHER_ACCOUNT } }],
		credential: { orgId: ORG, accountId: ACCOUNT },
		expected: null,
	},
	{
		name: "an org-scoped credential does not take its account's report in another org",
		reports: [{ metadata: { orgId: OTHER_ORG, accountId: ACCOUNT } }],
		credential: { orgId: ORG, accountId: ACCOUNT },
		expected: null,
	},
	{
		name: "an org-scoped credential does not take its account's org-less report",
		reports: [{ metadata: { accountId: ACCOUNT } }],
		credential: { orgId: ORG, accountId: ACCOUNT },
		expected: null,
	},
	{
		name: "an org-scoped credential does not take another provider's report",
		reports: [{ provider: OTHER_PROVIDER, metadata: { orgId: ORG, accountId: ACCOUNT } }],
		credential: { orgId: ORG, accountId: ACCOUNT },
		expected: null,
	},
	{
		name: "org ids compare folded for case and padding",
		reports: [{ metadata: { orgId: " ORG-1 ", accountId: ACCOUNT } }],
		credential: { orgId: " Org-1", accountId: ACCOUNT },
		expected: 0,
	},
	{
		name: "an org-only credential takes the lone report in its org",
		reports: [{ metadata: { orgId: OTHER_ORG } }, { metadata: { orgId: ORG } }],
		credential: { orgId: ORG },
		expected: 1,
	},
	{
		name: "an org-only credential takes no report when its org has two",
		reports: [{ metadata: { orgId: ORG } }, { metadata: { orgId: ORG } }],
		credential: { orgId: ORG },
		expected: null,
	},
	{
		name: "an org-less credential does not take an org-attributed report of its account",
		reports: [{ metadata: { orgId: ORG, accountId: ACCOUNT } }, { metadata: { accountId: OTHER_ACCOUNT } }],
		credential: { accountId: ACCOUNT },
		expected: null,
	},
	{
		name: "an org-less credential takes the provider's only report when it is org-less",
		reports: [{ metadata: { accountId: OTHER_ACCOUNT } }],
		credential: { accountId: ACCOUNT },
		expected: 0,
	},
	{
		name: "an org-less credential does not take the only org-less report among several",
		reports: [{ metadata: { accountId: OTHER_ACCOUNT } }, { metadata: { orgId: ORG, accountId: OTHER_ACCOUNT } }],
		credential: { accountId: ACCOUNT },
		expected: null,
	},
	{
		name: "another provider's report neither matches nor counts against the lone report",
		reports: [
			{ provider: OTHER_PROVIDER, metadata: { accountId: ACCOUNT } },
			{ metadata: { accountId: OTHER_ACCOUNT } },
		],
		credential: { accountId: ACCOUNT },
		expected: 1,
	},
	...identityFieldRows(),
];

function buildReports(specs: ReportSpec[]): UsageReport[] {
	return specs.map((spec, index) => {
		const provider = spec.provider ?? PROVIDER;
		return {
			provider,
			fetchedAt: 0,
			limits: [
				{ id: `report-${index}`, label: "window", scope: { provider, ...spec.scope }, amount: { unit: "percent" } },
			],
			...(spec.metadata ? { metadata: spec.metadata } : {}),
		};
	});
}

function usageBroker(reports: UsageReport[]): FakeBroker {
	return fakeBroker((request, init) => {
		if (request === "GET /v1/usage") return Response.json({ generatedAt: 0, reports });
		return holdUntilAborted(init);
	});
}

function oauthCredential(identity: Identity): OAuthCredential {
	return { type: "oauth", access: "access", refresh: "refresh", expires: 0, ...identity };
}

describe("a broker usage report", () => {
	test.each(USAGE_ROWS)("$name", async ({ reports: specs, credential, expected }) => {
		const reports = buildReports(specs);
		const store = openStore(usageBroker(reports));
		const report = await store.getUsageReport(PROVIDER, oauthCredential(credential));
		expect(report?.limits[0]?.id ?? null).toBe(expected === null ? null : `report-${expected}`);
	});
});

describe("a usage overlay", () => {
	test.each(USAGE_ROWS)("$name", async ({ reports: specs, credential, expected }) => {
		const reports = buildReports(specs);
		const store = openStore(usageBroker(reports));
		const overlay: UsageReport = {
			provider: PROVIDER,
			fetchedAt: Date.now(),
			limits: [{ id: "overlay", label: "headers", scope: { provider: PROVIDER }, amount: { unit: "percent" } }],
			metadata: { ...credential },
		};
		expect(store.ingestUsageReport(PROVIDER, oauthCredential(credential), overlay)).toBe(true);
		const merged = await store.fetchUsageReports();
		const carriers = (merged ?? []).flatMap((report, index) =>
			report.limits.some(limit => limit.id === "overlay") ? [index] : [],
		);
		// Merged into the report of its identity, or appended as its own row when none is.
		expect(carriers).toEqual([expected ?? reports.length]);
		expect(merged?.length).toBe(reports.length + (expected === null ? 1 : 0));
	});
});

describe("a credential block's reconcile deadline", () => {
	const T0 = 1_800_000_000_000;
	const MINUTES_5 = 5 * 60_000;
	const HOUR = 60 * 60_000;

	function blockStore(blocks: CredentialBlockSnapshot[], next?: CredentialBlockSnapshot[]) {
		const broker = fakeBroker((request, init) => {
			if (request === "GET /v1/snapshot" && next) return Response.json(snapshotResponse(2, [entry(1, next)]));
			return holdUntilAborted(init);
		});
		return openStore(broker, { initialSnapshot: snapshotResponse(1, [entry(1, blocks)]) });
	}

	test("a block the store has not seen is held five minutes past its update, or to its expiry if sooner", () => {
		setSystemTime(new Date(T0));
		const store = blockStore([
			{ providerKey: PROVIDER, blockScope: "", blockedUntilMs: T0 + HOUR, updatedAtMs: T0 - 60_000 },
			{ providerKey: PROVIDER, blockScope: "model-a", blockedUntilMs: T0 + 120_000, updatedAtMs: T0 - 60_000 },
		]);
		expect(store.getCredentialBlockReconcileAfter(1, PROVIDER, "")).toBe(T0 - 60_000 + MINUTES_5);
		expect(store.getCredentialBlockReconcileAfter(1, PROVIDER, "model-a")).toBe(T0 + 120_000);
	});

	test("a block with no update time is held five minutes past when the store first saw it", () => {
		setSystemTime(new Date(T0));
		const store = blockStore([{ providerKey: PROVIDER, blockScope: "", blockedUntilMs: T0 + HOUR }]);
		expect(store.getCredentialBlockReconcileAfter(1, PROVIDER, "")).toBe(T0 + MINUTES_5);
	});

	test.each([
		{
			name: "an unchanged block keeps its deadline across a refresh",
			before: { blockedUntilMs: T0 + HOUR },
			after: { blockedUntilMs: T0 + HOUR },
			deadline: T0 + MINUTES_5,
		},
		{
			name: "a block whose expiry moved is held again from the refresh",
			before: { blockedUntilMs: T0 + HOUR },
			after: { blockedUntilMs: T0 + 2 * HOUR },
			deadline: T0 + 60_000 + MINUTES_5,
		},
		{
			name: "a block whose update time moved is held again from that update",
			before: { blockedUntilMs: T0 + HOUR, updatedAtMs: T0 - 60_000 },
			after: { blockedUntilMs: T0 + HOUR, updatedAtMs: T0 + 30_000 },
			deadline: T0 + 30_000 + MINUTES_5,
		},
	])("$name", async ({ before, after, deadline }) => {
		setSystemTime(new Date(T0));
		const store = blockStore(
			[{ providerKey: PROVIDER, blockScope: "", ...before }],
			[{ providerKey: PROVIDER, blockScope: "", ...after }],
		);
		setSystemTime(new Date(T0 + 60_000));
		expect((await store.refreshSnapshot()).generation).toBe(2);
		expect(store.getCredentialBlockReconcileAfter(1, PROVIDER, "")).toBe(deadline);
	});
});

describe("the background sync", () => {
	test("long-polls a broker without a snapshot stream from then on, and a 304 is not a failure", async () => {
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		let polls = 0;
		const broker = fakeBroker((request, init) => {
			if (request === STREAM) return new Response("not found", { status: 404 });
			if (request !== LONG_POLL) return holdUntilAborted(init);
			polls += 1;
			if (polls === 1) return Response.json(snapshotResponse(2, [entry(7)]));
			if (polls === 2) return new Response(null, { status: 304 });
			return holdUntilAborted(init);
		});
		const store = openStore(broker, { streamSnapshots: true });
		await broker.arrival(LONG_POLL, 3);
		expect(store.snapshot.generation).toBe(2);
		expect(store.snapshot.credentials.map(credential => credential.id)).toEqual([7]);
		expect(broker.requests.filter(request => request === STREAM)).toHaveLength(1);
		expect(warnings).toEqual([]);
	});
});

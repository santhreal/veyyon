/**
 * Two subscriptions that share one email address must be distinguishable, and only the one that
 * serves this session may be marked as serving it.
 *
 * THE CLASS. Anthropic sells a personal Max plan and a Team seat to the same address, so a store
 * routinely holds several credentials whose only difference is the organisation. Before the account
 * card existed, `/logout` picked accounts by IDENTITY MATCHING: it compared email, account id and
 * org id against whatever the session reported as active, and every ambiguity in that comparison
 * marked the wrong row. The legacy row with no org matched the org-scoped one, an org-only session
 * matched every member of the org, and two seats in one org matched each other. The card replaced
 * the comparison with the credential ID the session is routed to, which cannot be ambiguous, and
 * the label ladder replaced the composite string. This suite is what keeps both halves honest,
 * because the ambiguity is a property of the DATA and it did not go away with the comparison.
 *
 * WHAT THIS SUITE PINS.
 *
 *  1. Exactly the routed credential is `activeForSession`. Never a sibling, never the legacy
 *     org-less row, never every member of the org.
 *  2. The routed row is identified by id, so two seats in ONE org on distinct emails, and two orgs
 *     on ONE email, both resolve to a single row.
 *  3. Every row is distinguishable on screen: the label is the shared email and the identity detail
 *     carries the organisation, so three rows read as three different accounts rather than as one
 *     address repeated three times.
 *  4. A pin that names a credential the store does not hold marks nothing active. A "not found"
 *     that fell through to a match-anything comparison is how the original defect surfaced.
 *
 * WHAT IT DOES NOT CATCH. Rendering (glyphs, column widths, the sidebar) belongs to
 * `test/modes/components/account-manager.test.ts`. Whether a request actually goes to the routed
 * credential is the registry's contract, not the inventory's.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import {
	type AccountRow,
	accountDisplayLabel,
	accountIdentityDetail,
	buildAccountInventory,
} from "@veyyon/coding-agent/session/account-inventory";

const PROVIDER = "anthropic";
const SESSION_ID = "session-two-subscriptions";
const SHARED_EMAIL = "shared@example.com";

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-two-subscriptions-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
	if (!authStorage) throw new Error("test setup failed");
	await authStorage.set(PROVIDER, []);
});

function oauth(options: { email?: string; accountId?: string; orgId?: string; orgName?: string }): AuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${options.orgId ?? "legacy"}-${options.accountId ?? "shared"}`,
		refresh: `refresh-${options.orgId ?? "legacy"}-${options.accountId ?? "shared"}`,
		expires: Date.now() + 8 * 60 * 60_000,
		accountId: options.accountId ?? "account-shared",
		email: options.email ?? SHARED_EMAIL,
	};
	if (options.orgId) credential.orgId = options.orgId;
	if (options.orgName) credential.orgName = options.orgName;
	return credential;
}

/** The rows the card would paint right now, in store order. Reads; never writes. */
function paint(): AccountRow[] {
	const storage = authStorage;
	if (!storage) throw new Error("test setup failed");
	const group = buildAccountInventory(storage, { sessionId: SESSION_ID }).providers.find(
		entry => entry.provider === PROVIDER,
	);
	if (!group) throw new Error("the seeded provider produced no group");
	return [...group.rows];
}

/**
 * Seed the store and return the rows. Seeding REPLACES the provider's credentials and resets its
 * session assignments, so a test pins after seeding and then reads through {@link paint}: re-seeding
 * to observe would drop the pin it was about to assert on.
 */
async function seed(credentials: AuthCredential[]): Promise<AccountRow[]> {
	const storage = authStorage;
	if (!storage) throw new Error("test setup failed");
	await storage.set(PROVIDER, credentials);
	return paint();
}

/** The three-row shape that broke identity matching: two orgs and one legacy row, one address. */
async function threeSubscriptions(): Promise<AccountRow[]> {
	return seed([
		oauth({ orgId: "org-team", orgName: "Team Workspace" }),
		oauth({ orgId: "org-max", orgName: "Personal Max" }),
		oauth({}),
	]);
}

function activeIds(rows: readonly AccountRow[]): number[] {
	return rows.filter(row => row.activeForSession).map(row => row.credentialId);
}

function chosenIds(rows: readonly AccountRow[]): number[] {
	return rows.filter(row => row.selectedForProvider).map(row => row.credentialId);
}

function predictedIds(rows: readonly AccountRow[]): number[] {
	return rows.filter(row => row.activeIsPrediction).map(row => row.credentialId);
}

function pin(credentialId: number): boolean {
	if (!authStorage) throw new Error("test setup failed");
	return authStorage.pinSessionCredential(PROVIDER, SESSION_ID, credentialId);
}

describe("two subscriptions on one email", () => {
	test("marks only the routed credential, not its org-less sibling", async () => {
		const rows = await threeSubscriptions();
		const personalMax = rows.find(row => row.orgId === "org-max");
		if (!personalMax) throw new Error("test setup failed");

		expect(pin(personalMax.credentialId)).toBe(true);

		const painted = paint();
		expect(activeIds(painted)).toEqual([personalMax.credentialId]);
		expect(chosenIds(painted)).toEqual([personalMax.credentialId]);
		// An observation, not a guess: the operator named the account, so no row is a prediction.
		expect(predictedIds(painted)).toEqual([]);
	});

	test("marks only the legacy row when that is the one routed", async () => {
		const rows = await threeSubscriptions();
		const legacy = rows.find(row => row.orgId === undefined);
		if (!legacy) throw new Error("test setup failed");

		expect(pin(legacy.credentialId)).toBe(true);

		const painted = paint();
		expect(activeIds(painted)).toEqual([legacy.credentialId]);
		expect(chosenIds(painted)).toEqual([legacy.credentialId]);
		expect(predictedIds(painted)).toEqual([]);
	});

	/** Two seats in one org pool: same organisation, distinct people. */
	test("marks one seat when two members share an org", async () => {
		const rows = await seed([
			oauth({
				email: "alice@example.com",
				accountId: "account-alice",
				orgId: "org-team",
				orgName: "Team Workspace",
			}),
			oauth({ email: "bob@example.com", accountId: "account-bob", orgId: "org-team", orgName: "Team Workspace" }),
		]);
		const alice = rows.find(row => row.email === "alice@example.com");
		if (!alice) throw new Error("test setup failed");

		expect(pin(alice.credentialId)).toBe(true);

		const painted = paint();
		expect(activeIds(painted)).toEqual([alice.credentialId]);
		expect(chosenIds(painted)).toEqual([alice.credentialId]);
		expect(predictedIds(painted)).toEqual([]);
	});

	/**
	 * A pin naming a credential the store does not hold is REFUSED, so nothing was chosen. The card
	 * still marks the one row that would serve the next request, and it has to say that mark is a
	 * PREDICTION: a refused pin surfacing as a chosen account is exactly how identity matching used
	 * to present "no match" as "matches this one".
	 */
	test("chooses nothing when the pinned credential is not stored", async () => {
		const rows = await threeSubscriptions();
		const unknownId = Math.max(...rows.map(row => row.credentialId)) + 1000;

		expect(pin(unknownId)).toBe(false);

		const painted = paint();
		expect(chosenIds(painted)).toEqual([]);
		// Whatever is marked serving is a prediction, it is at most one row, and it is a row that
		// exists. The unknown id must never appear.
		expect(activeIds(painted)).toEqual(predictedIds(painted));
		expect(activeIds(painted).length).toBeLessThanOrEqual(1);
		expect(activeIds(painted)).not.toContain(unknownId);
		for (const id of activeIds(painted)) {
			expect(rows.map(row => row.credentialId)).toContain(id);
		}
	});

	/**
	 * The reader still has to tell the three rows apart, which is what the composite label used to
	 * do. The label is the address they share, so the organisation has to survive in the detail line
	 * or the card shows one account three times.
	 */
	test("tells the three rows apart by label plus identity detail", async () => {
		const rows = await threeSubscriptions();

		const described = rows
			.map(row => [accountDisplayLabel(row), ...accountIdentityDetail(row)].join(" · "))
			.sort((left, right) => left.localeCompare(right));

		expect(described).toEqual([
			`${SHARED_EMAIL}`,
			`${SHARED_EMAIL} · org Personal Max`,
			`${SHARED_EMAIL} · org Team Workspace`,
		]);
	});

	/** The organisation reaches the row at all: the inventory has to copy it off the credential. */
	test("carries the organisation off the stored credential", async () => {
		const rows = await threeSubscriptions();

		expect(rows.map(row => row.orgId ?? "—").sort()).toEqual(["org-max", "org-team", "—"]);
		expect(rows.map(row => row.orgName ?? "—").sort()).toEqual(["Personal Max", "Team Workspace", "—"]);
		expect(new Set(rows.map(row => row.email))).toEqual(new Set([SHARED_EMAIL]));
	});
});

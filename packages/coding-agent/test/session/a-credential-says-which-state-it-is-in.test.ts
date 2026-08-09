/**
 * WHY THIS SUITE EXISTS. An account row used to carry no statement at all about its own
 * credential's lifetime. Two accounts, one whose token renews itself and one whose login has
 * ended, rendered identically, so the only way to learn which was which was to send a request and
 * read the failure. This pins the five states apart, the boundary each one starts at, the
 * precedence between them, and the one sentence both account surfaces print about them.
 *
 * THE CLASS IT CLOSES. Every member of {@link AccountCredentialState}, at its boundary, through
 * the real derivation and both real renderers. The state map is an exhaustive
 * `Record<AccountCredentialState, …>`, so ADDING A STATE fails `check:ts` until someone records
 * what it looks like on screen: a new member cannot land silently rendered as nothing.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the runtime actually refreshes a renewable token, only
 * that the card stays quiet about one; `AuthStorage`'s own refresh suites own that. It does not
 * assert colour, because the glyph kind is resolved to a themed symbol by the card's caller.
 *
 * THE RENEWABLE CASES ARE THE POINT, not an afterthought. A working account must carry NO warning:
 * a line under every short-lived oauth token is the exact defect that put "no usage probe
 * configured for provider anthropic" under nine healthy Anthropic accounts, and it trains a reader
 * to ignore the row that means something.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import {
	accountGlyphKind,
	accountHeadLine,
	accountNoticeLines,
} from "@veyyon/coding-agent/modes/components/account-manager-rows";
import type { AccountCredentialState, AccountRow } from "@veyyon/coding-agent/session/account-inventory";
import {
	accountCredentialStatus,
	buildAccountInventory,
	CREDENTIAL_EXPIRY_WARN_MS,
	credentialStateNote,
} from "@veyyon/coding-agent/session/account-inventory";
import { renderAccountStatus } from "@veyyon/coding-agent/slash-commands/helpers/account-status";
import { stripAnsi } from "@veyyon/utils";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const REFRESH_FAILURE = "oauth refresh failed: invalid_grant: the authorization grant is invalid";

function row(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId: 1,
		type: "oauth",
		usage: [],
		activeForSession: false,
		activeIsPrediction: false,
		selectedForProvider: false,
		...overrides,
	};
}

/**
 * One fixture per state, with what every surface must say about it.
 *
 * `note` is the shared sentence or `null` for the states that must stay silent; `glyph` and `tag`
 * are what the card shows for a row that is neither routed nor chosen, so the credential state is
 * the only thing either field can be reporting.
 */
interface StateCase {
	row: AccountRow;
	note: string | null;
	glyph: "serving" | "idle" | "failed" | "blocked";
	tag: string;
}

const STATE_CASES: Record<AccountCredentialState, StateCase> = {
	valid: {
		row: row({ tokenExpiresAtMs: NOW + HOUR, renewable: true }),
		note: null,
		glyph: "idle",
		tag: "",
	},
	expiring: {
		row: row({ tokenExpiresAtMs: NOW + 4 * 60_000, renewable: false }),
		note: "the access token expires in 4m and no refresh token is stored",
		glyph: "idle",
		tag: "",
	},
	expired: {
		row: row({ tokenExpiresAtMs: NOW - 60_000, renewable: false }),
		note: "the access token expired and no refresh token is stored",
		glyph: "failed",
		tag: "needs attention",
	},
	blocked: {
		row: row({ blockedUntilMs: NOW + 10 * 60_000, renewable: true }),
		note: null,
		glyph: "blocked",
		tag: "rate limited",
	},
	"refresh-failed": {
		row: row({ health: "failed", healthReason: REFRESH_FAILURE, renewable: true }),
		note: null,
		glyph: "failed",
		tag: "needs attention",
	},
};

describe("a credential says which state it is in", () => {
	for (const [state, expected] of Object.entries(STATE_CASES) as Array<[AccountCredentialState, StateCase]>) {
		test(`derives ${state}`, () => {
			expect(accountCredentialStatus(expected.row, NOW).state).toBe(state);
		});

		test(`shows ${state} the same way on every part of a row`, () => {
			expect(accountGlyphKind(expected.row, NOW)).toBe(expected.glyph);
			expect(accountHeadLine(expected.row, NOW).tag).toBe(expected.tag);
			const notes = accountNoticeLines(expected.row, NOW);
			if (expected.note === null) {
				expect(notes.some(line => line.includes("access token"))).toBe(false);
			} else {
				expect(notes).toContain(`${expected.note} · press a to sign in again`);
			}
		});
	}

	/**
	 * A renewable token that has ALREADY expired is the case most likely to be reported as a bug
	 * that is not one: the runtime renews it on the next request, so the account works. It gets the
	 * state, and nothing else.
	 */
	test("says nothing on screen about a renewable token that expired", () => {
		const renewable = row({ tokenExpiresAtMs: NOW - HOUR, renewable: true });

		expect(accountCredentialStatus(renewable, NOW)).toEqual({ state: "expired", renewable: true });
		expect(credentialStateNote(renewable, NOW)).toBeUndefined();
		expect(accountGlyphKind(renewable, NOW)).toBe("idle");
		expect(accountHeadLine(renewable, NOW).tag).toBe("");
		expect(accountNoticeLines(renewable, NOW)).toEqual([]);
	});

	/** An api key has no clock. Absent fields are "no lifetime", never "expired at the epoch". */
	test("leaves an api key out of the expiry axis entirely", () => {
		const key = row({ type: "api_key" });

		expect(accountCredentialStatus(key, NOW)).toEqual({ state: "valid", renewable: false });
		expect(credentialStateNote(key, NOW)).toBeUndefined();
		expect(accountNoticeLines(key, NOW)).toEqual([]);
	});
});

describe("the boundary each state starts at", () => {
	test("counts an expiry landing exactly now as expired", () => {
		expect(accountCredentialStatus(row({ tokenExpiresAtMs: NOW, renewable: false }), NOW).state).toBe("expired");
	});

	test("counts the far edge of the warning window as expiring", () => {
		const edge = row({ tokenExpiresAtMs: NOW + CREDENTIAL_EXPIRY_WARN_MS, renewable: false });
		expect(accountCredentialStatus(edge, NOW).state).toBe("expiring");
	});

	test("leaves a token one millisecond beyond the window alone", () => {
		const beyond = row({ tokenExpiresAtMs: NOW + CREDENTIAL_EXPIRY_WARN_MS + 1, renewable: false });
		expect(accountCredentialStatus(beyond, NOW).state).toBe("valid");
		expect(credentialStateNote(beyond, NOW)).toBeUndefined();
	});

	/** A block that lapses at this instant is over: the row is usable and must not wear the mark. */
	test("counts a block lapsing exactly now as over", () => {
		expect(accountCredentialStatus(row({ blockedUntilMs: NOW }), NOW).state).toBe("valid");
	});

	/** Only `expiring` and `blocked` end by themselves, so only they may carry a countdown. */
	test("carries a reset time for the states that resolve without a login", () => {
		expect(accountCredentialStatus(row({ blockedUntilMs: NOW + HOUR }), NOW).resetsAtMs).toBe(NOW + HOUR);
		expect(accountCredentialStatus(row({ tokenExpiresAtMs: NOW + 60_000 }), NOW).resetsAtMs).toBe(NOW + 60_000);
		expect(accountCredentialStatus(row({ tokenExpiresAtMs: NOW - 1 }), NOW).resetsAtMs).toBeUndefined();
		expect(
			accountCredentialStatus(row({ health: "failed", healthReason: REFRESH_FAILURE }), NOW).resetsAtMs,
		).toBeUndefined();
	});
});

describe("precedence between states", () => {
	/** A rejected refresh is final. A clock running down beside it changes nothing. */
	test("puts a rejected refresh ahead of every clock", () => {
		const row_ = row({
			health: "failed",
			healthReason: REFRESH_FAILURE,
			blockedUntilMs: NOW + HOUR,
			tokenExpiresAtMs: NOW - HOUR,
			renewable: false,
		});
		expect(accountCredentialStatus(row_, NOW).state).toBe("refresh-failed");
	});

	/** Unusable right now outranks a token's own clock, however far past it is. */
	test("puts a rate-limit block ahead of an expiry", () => {
		const row_ = row({ blockedUntilMs: NOW + HOUR, tokenExpiresAtMs: NOW - HOUR, renewable: false });
		expect(accountCredentialStatus(row_, NOW).state).toBe("blocked");
	});

	/**
	 * A probe that failed for any OTHER reason is not a statement about the credential's lifetime.
	 * An upstream outage must not read as an ended login, so the state stays `valid` while the glyph
	 * and the verbatim reason carry the probe failure.
	 */
	test("does not turn an ordinary probe failure into a credential state", () => {
		const outage = row({ health: "failed", healthReason: "503 upstream unavailable", renewable: false });

		expect(accountCredentialStatus(outage, NOW).state).toBe("valid");
		expect(credentialStateNote(outage, NOW)).toBeUndefined();
		expect(accountNoticeLines(outage, NOW)).toEqual(["503 upstream unavailable"]);
	});

	/** `unverifiable` is the weaker form of the same non-statement. */
	test("does not turn an unverifiable probe into a credential state", () => {
		const unverifiable = row({
			health: "unverifiable",
			healthReason: "no usage probe configured for provider anthropic",
			renewable: false,
		});
		expect(accountCredentialStatus(unverifiable, NOW).state).toBe("valid");
		expect(accountNoticeLines(unverifiable, NOW)).toEqual([]);
	});
});

describe("both account surfaces say the same thing", () => {
	/**
	 * The FACT is one owner's and the OFFER is the surface's: a text client has no `a` key to press,
	 * and a shared sentence naming the wrong remedy is worse than two agreeing on the fact.
	 */
	test("prints one shared sentence with each surface's own remedy", () => {
		const ending = row({ tokenExpiresAtMs: NOW - 60_000, renewable: false, activeForSession: true, name: "work" });
		const note = credentialStateNote(ending, NOW);
		expect(note).toBe("the access token expired and no refresh token is stored");

		expect(accountNoticeLines(ending, NOW)).toContain(`${note} · press a to sign in again`);

		const inline = renderAccountStatus(
			{
				providers: [{ provider: "anthropic", label: "Anthropic", rows: [ending] }],
				totalAccounts: 1,
				unhealthyCount: 0,
			},
			NOW,
			new Map(),
		)
			.map(line => stripAnsi(line))
			.join("\n");
		expect(inline).toContain(`${note} · /providers to sign in again`);
	});

	/** And both stay silent for the account that needs nothing. */
	test("keeps a working account clean on both surfaces", () => {
		const working = row({ tokenExpiresAtMs: NOW + HOUR, renewable: true, activeForSession: true, name: "work" });

		expect(accountNoticeLines(working, NOW)).toEqual([]);
		const inline = renderAccountStatus(
			{
				providers: [{ provider: "anthropic", label: "Anthropic", rows: [working] }],
				totalAccounts: 1,
				unhealthyCount: 0,
			},
			NOW,
			new Map(),
		)
			.map(line => stripAnsi(line))
			.join("\n");
		expect(inline).not.toContain("access token");
	});
});

/**
 * The facts the states are derived FROM have to come off the stored credential, so this half runs
 * against a real `SqliteAuthCredentialStore`. A hand-written row proves the derivation and nothing
 * about whether the inventory ever reads a token's clock: the field could be absent on every real
 * account and every test above would still pass.
 */
describe("the inventory reads a token's clock off the store", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-credential-state-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	async function seed(credential: AuthCredential): Promise<AccountRow> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("unit-credential-state", [credential]);
		const entry = buildAccountInventory(authStorage).providers.find(
			group => group.provider === "unit-credential-state",
		);
		const first = entry?.rows[0];
		if (!first) throw new Error("the seeded credential produced no row");
		return first;
	}

	test("carries the stored expiry and a stored refresh token", async () => {
		const stored = await seed({
			type: "oauth",
			access: "access-live",
			refresh: "refresh-live",
			expires: NOW + HOUR,
		});

		expect(stored.tokenExpiresAtMs).toBe(NOW + HOUR);
		expect(stored.renewable).toBe(true);
	});

	/** The state that ends a login: an oauth row whose refresh token is empty. */
	test("reports a credential with no refresh token as not renewable", async () => {
		const stored = await seed({ type: "oauth", access: "access-live", refresh: "", expires: NOW + HOUR });

		expect(stored.renewable).toBe(false);
		expect(accountCredentialStatus(stored, NOW - 2 * HOUR).state).toBe("valid");
		expect(accountCredentialStatus(stored, NOW + 2 * HOUR).state).toBe("expired");
	});

	/**
	 * A provider that states no expiry writes zero, which is NOT a token that expired at the epoch.
	 * Reading it as one would show every such account as a dead login.
	 */
	test("treats an unstated expiry as no clock rather than as the epoch", async () => {
		const stored = await seed({ type: "oauth", access: "access-live", refresh: "", expires: 0 });

		expect(stored.tokenExpiresAtMs).toBeUndefined();
		expect(accountCredentialStatus(stored, NOW).state).toBe("valid");
	});

	test("gives an api key no clock at all", async () => {
		const stored = await seed({ type: "api_key", key: "sk-unit-credential-state" });

		expect(stored.tokenExpiresAtMs).toBeUndefined();
		expect(stored.renewable).toBeUndefined();
		expect(accountCredentialStatus(stored, NOW).state).toBe("valid");
	});
});

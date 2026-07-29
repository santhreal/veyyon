/**
 * A lifetime that runs out stops the substitution, in a session that never reloads the vault.
 *
 * WHY THIS SUITE EXISTS. The handbook said, in as many words, "Expiry is also checked when a secret
 * is used, so a session left open overnight cannot spend a credential whose lifetime ended while
 * you were away." That was not true. `isExpired` was consulted in exactly one place,
 * `SecretVault.load`, so expiry was enforced when a session STARTED and at no other moment. A
 * session already running holds its values inside the obfuscator, and nothing there knew a deadline
 * existed. Leave veyyon open over a weekend and a one-day credential kept being substituted into
 * commands for as long as the process lived.
 *
 * That is the whole feature failing, not an edge case. `secrets.defaultTtl` is one day, an agent
 * session running for longer than a day is ordinary, and the documented promise was the opposite of
 * the behaviour. The reconcile that would have caught it only ran after a `/secret` subcommand, so
 * the lifetime was in practice enforced by the operator happening to type a command.
 *
 * What is pinned here: the deadline is enforced on the substitution path itself, a lapse is
 * announced rather than silent, `extend` really moves the deadline mid-session, and the check costs
 * nothing when nothing expires.
 */
import { describe, expect, it } from "bun:test";
import {
	describeSecretExpiry,
	type SecretExpiryEvent,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";

const VALUE = "ghp_R2d2c3poIHRva2VuIGV4YW1wbGU";
const OTHER = "sk-live-qrstuvwxyzabcdefghij";
const START = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** An obfuscator with a settable clock and a record of every expiry it announced. */
function build(options: { entries: Array<{ name: string; value: string; expiresAt: number | null }>; at?: number }): {
	obfuscator: SecretObfuscator;
	expired: string[];
	setNow: (at: number) => void;
} {
	let now = options.at ?? START;
	const expired: string[] = [];
	const obfuscator = new SecretObfuscator(
		options.entries.map(entry => ({
			type: "plain" as const,
			origin: "config" as const,
			content: entry.value,
			name: entry.name,
			expiresAt: entry.expiresAt,
		})),
		{ now: () => now, onExpiry: event => expired.push(event.name) },
	);
	return { obfuscator, expired, setNow: at => (now = at) };
}

describe("a secret whose lifetime has run out", () => {
	/**
	 * THE BUG, stated as the failing case it was.
	 *
	 * The command still carries `#GITHUB_TOKEN#` after the deadline. Before this, the same call
	 * returned the real credential for as long as the process was alive.
	 */
	it("is no longer substituted into a command", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "GITHUB_TOKEN", value: VALUE, expiresAt: START + HOUR }],
		});

		expect(obfuscator.deobfuscate("curl -H 'Bearer #GITHUB_TOKEN#'")).toBe(`curl -H 'Bearer ${VALUE}'`);

		setNow(START + HOUR + 1);

		expect(obfuscator.deobfuscate("curl -H 'Bearer #GITHUB_TOKEN#'")).toBe("curl -H 'Bearer #GITHUB_TOKEN#'");
	});

	/**
	 * The placeholder is left in place rather than replaced with nothing.
	 *
	 * A command that fails loudly beats one that runs without the credential it needed. An empty
	 * `Authorization:` header can look like an unauthenticated request the agent meant to make.
	 */
	it("leaves the placeholder visible rather than blanking it", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "DEPLOY_KEY", value: VALUE, expiresAt: START + HOUR }],
		});
		setNow(START + 2 * HOUR);

		expect(obfuscator.deobfuscate("scp -i #DEPLOY_KEY# build.tar host:/srv")).toContain("#DEPLOY_KEY#");
	});

	/**
	 * Announced exactly once, naming the secret and how to restore it.
	 *
	 * Silence here produces the most confusing failure the feature can: the request 401s and nothing
	 * anywhere connects that to a lifetime. Once, not once per call, or a session that keeps using
	 * the placeholder would bury everything else in the channel.
	 */
	it("announces the expiry a single time", () => {
		const { obfuscator, expired, setNow } = build({
			entries: [{ name: "GITHUB_TOKEN", value: VALUE, expiresAt: START + HOUR }],
		});
		setNow(START + HOUR + 1);

		for (let i = 0; i < 5; i++) obfuscator.deobfuscate("use #GITHUB_TOKEN#");

		expect(expired).toEqual(["GITHUB_TOKEN"]);
	});

	/**
	 * Runtime expiry revokes an in-memory mapping and performs no vault I/O. Its structured state
	 * and operator wording must say the ciphertext remains; only an event from an operation that
	 * actually removed persisted data may claim deletion.
	 */
	it("reports truthful persisted-deletion state and wording", () => {
		let now = START;
		let expiry: SecretExpiryEvent | undefined;
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", origin: "config", content: VALUE, name: "GITHUB_TOKEN", expiresAt: START + HOUR }],
			{ now: () => now, onExpiry: event => (expiry = event) },
		);
		now = START + HOUR;

		expect(obfuscator.deobfuscate("#GITHUB_TOKEN#")).toBe("#GITHUB_TOKEN#");
		expect(expiry).toEqual({ name: "GITHUB_TOKEN", persistedCiphertextRemoved: false });
		expect(describeSecretExpiry(expiry!)).toContain("has not yet been deleted from the vault");
		expect(describeSecretExpiry(expiry!)).not.toContain("was deleted from the vault");
		expect(describeSecretExpiry({ name: "GITHUB_TOKEN", persistedCiphertextRemoved: true })).toContain(
			"was deleted from the vault",
		);
	});

	/** Reported as gone by `hasNamedSecret`, so a caller cannot see a live secret the other path refuses. */
	it("is reported as absent by hasNamedSecret", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "GITHUB_TOKEN", value: VALUE, expiresAt: START + HOUR }],
		});

		expect(obfuscator.hasNamedSecret("GITHUB_TOKEN")).toBe(true);

		setNow(START + HOUR + 1);

		expect(obfuscator.hasNamedSecret("GITHUB_TOKEN")).toBe(false);
	});

	/**
	 * And by `knowsPlaceholder`, which is what the audit log asks.
	 *
	 * Otherwise the log records a credential as spent on a command that went out with the
	 * placeholder still in it. A log that overstates what was used is worse than no log, because it
	 * is read as evidence.
	 */
	it("is not recorded as used by the audit log's predicate", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "GITHUB_TOKEN", value: VALUE, expiresAt: START + HOUR }],
		});
		setNow(START + HOUR + 1);

		expect(obfuscator.knowsPlaceholder("#GITHUB_TOKEN#")).toBe(false);
	});
});

describe("the deadline itself", () => {
	/** Expiry is inclusive of the moment: `expiresAt` is when it stops, not the last moment it works. */
	it("takes effect exactly at expiresAt", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "TOKEN_A", value: VALUE, expiresAt: START + HOUR }],
		});

		setNow(START + HOUR - 1);
		expect(obfuscator.deobfuscate("#TOKEN_A#")).toBe(VALUE);

		setNow(START + HOUR);
		expect(obfuscator.deobfuscate("#TOKEN_A#")).toBe("#TOKEN_A#");
	});

	/** A secret that never expires is never dropped, however far the clock is pushed. */
	it("does not exist for a secret with no lifetime", () => {
		const { obfuscator, expired, setNow } = build({
			entries: [{ name: "FOREVER", value: VALUE, expiresAt: null }],
		});
		setNow(START + 1000 * 365 * 24 * HOUR);

		expect(obfuscator.deobfuscate("#FOREVER#")).toBe(VALUE);
		expect(expired).toEqual([]);
	});

	/**
	 * An already-expired entry handed in at construction is refused from the first use.
	 *
	 * The vault prunes these before they get here, so this is defence in depth rather than the main
	 * path. It matters because an SDK caller builds this object directly.
	 */
	it("applies to an entry that was already expired when it was added", () => {
		const { obfuscator, expired } = build({
			entries: [{ name: "STALE", value: VALUE, expiresAt: START - HOUR }],
		});

		expect(obfuscator.deobfuscate("#STALE#")).toBe("#STALE#");
		expect(expired).toEqual(["STALE"]);
	});
});

describe("several secrets with different lifetimes", () => {
	/**
	 * Only the lapsed one stops working.
	 *
	 * A check that dropped the whole map at the first deadline would take working credentials down
	 * with the expired one, which is a worse outage than the bug it fixes.
	 */
	it("drops only the expired secret", () => {
		const { obfuscator, expired, setNow } = build({
			entries: [
				{ name: "SHORT", value: VALUE, expiresAt: START + HOUR },
				{ name: "LONG_KEY", value: OTHER, expiresAt: START + 100 * HOUR },
			],
		});
		setNow(START + 2 * HOUR);

		expect(obfuscator.deobfuscate("#SHORT# and #LONG_KEY#")).toBe(`#SHORT# and ${OTHER}`);
		expect(expired).toEqual(["SHORT"]);
	});

	/** Each is announced as its own deadline passes, in the order the deadlines fall. */
	it("announces each expiry as its deadline passes", () => {
		const { obfuscator, expired, setNow } = build({
			entries: [
				{ name: "FIRST", value: VALUE, expiresAt: START + HOUR },
				{ name: "SECOND", value: OTHER, expiresAt: START + 2 * HOUR },
			],
		});

		setNow(START + HOUR);
		obfuscator.deobfuscate("#FIRST# #SECOND#");
		expect(expired).toEqual(["FIRST"]);

		setNow(START + 2 * HOUR);
		obfuscator.deobfuscate("#FIRST# #SECOND#");
		expect(expired).toEqual(["FIRST", "SECOND"]);
	});
});

describe("extending a lifetime mid-session", () => {
	/**
	 * Moves the deadline the obfuscator enforces, not only the one the vault stores.
	 *
	 * `/secret extend` reconciles by re-adding every live secret. The value is unchanged, so the
	 * re-add takes an early return, and a version that carried only the value would leave the OLD
	 * deadline in place: the operator extends the credential, is told it now lasts a week, and it
	 * stops working at the original hour anyway.
	 */
	it("keeps the secret working past its original deadline", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "TOKEN_A", value: VALUE, expiresAt: START + HOUR }],
		});

		obfuscator.addNamedSecret("TOKEN_A", VALUE, START + 100 * HOUR);
		setNow(START + 50 * HOUR);

		expect(obfuscator.deobfuscate("#TOKEN_A#")).toBe(VALUE);
	});

	/** Extending to `never` clears the deadline rather than leaving the old one behind. */
	it("removes the deadline when extended to never", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "TOKEN_A", value: VALUE, expiresAt: START + HOUR }],
		});

		obfuscator.addNamedSecret("TOKEN_A", VALUE, null);
		setNow(START + 10_000 * HOUR);

		expect(obfuscator.deobfuscate("#TOKEN_A#")).toBe(VALUE);
	});

	/** A secret added with no lifetime is not given one by accident. */
	it("adds a secret with no deadline when none is passed", () => {
		const { obfuscator, setNow } = build({ entries: [] });

		obfuscator.addNamedSecret("FRESH", VALUE);
		setNow(START + 10_000 * HOUR);

		expect(obfuscator.deobfuscate("#FRESH#")).toBe(VALUE);
	});

	/**
	 * SHORTENING works too, which is the direction a re-add can also move.
	 *
	 * Re-adding with an earlier deadline has to take effect, or a credential could be given a
	 * shorter life and keep the longer one.
	 */
	it("honours a deadline brought forward", () => {
		const { obfuscator, setNow } = build({
			entries: [{ name: "TOKEN_A", value: VALUE, expiresAt: START + 100 * HOUR }],
		});

		obfuscator.addNamedSecret("TOKEN_A", VALUE, START + HOUR);
		setNow(START + 2 * HOUR);

		expect(obfuscator.deobfuscate("#TOKEN_A#")).toBe("#TOKEN_A#");
	});
});

describe("secrets that carry no lifetime at all", () => {
	/**
	 * Environment and `secrets.yml` entries are untouched by any of this.
	 *
	 * They have no lifetime to express, and `undefined` has to mean the same as `null` or every
	 * auto-detected environment secret would need a field it has no value for.
	 */
	it("keeps working with no expiresAt field", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: VALUE }], {
			now: () => START + 10_000 * HOUR,
		});

		const placeholder = obfuscator.obfuscate(VALUE);
		expect(placeholder).not.toContain(VALUE);
		expect(obfuscator.deobfuscate(placeholder)).toBe(VALUE);
	});

	/**
	 * The clock is not consulted when nothing expires, which is what keeps the check free.
	 *
	 * `deobfuscate` runs on every string of every tool call. A scan of the expiry map per call would
	 * be a real cost for a check that fires once per lifetime, so the cached soonest deadline short
	 * circuits it. Counting clock reads is how that shows up in a test rather than in a benchmark
	 * nobody runs.
	 */
	it("does not read the clock when no secret has a deadline", () => {
		let reads = 0;
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", origin: "config", content: VALUE, name: "TOKEN_A", expiresAt: null }],
			{
				now: () => {
					reads++;
					return START;
				},
			},
		);

		for (let i = 0; i < 100; i++) obfuscator.deobfuscate("use #TOKEN_A# here");

		expect(reads).toBe(0);
	});

	/** With a deadline it reads the clock once per call, not once per secret or once per match. */
	it("reads the clock once per call when a deadline exists", () => {
		let reads = 0;
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUE, name: "A_TOKEN", expiresAt: START + 100 * HOUR },
				{ type: "plain", origin: "config", content: OTHER, name: "B_TOKEN", expiresAt: START + 200 * HOUR },
			],
			{
				now: () => {
					reads++;
					return START;
				},
			},
		);

		obfuscator.deobfuscate("use #A_TOKEN# and #B_TOKEN# and #A_TOKEN#");

		expect(reads).toBe(1);
	});

	/** A message with no placeholder in it does not even reach the expiry check. */
	it("does not read the clock for text with no placeholder", () => {
		let reads = 0;
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", origin: "config", content: VALUE, name: "TOKEN_A", expiresAt: START + HOUR }],
			{
				now: () => {
					reads++;
					return START;
				},
			},
		);

		obfuscator.deobfuscate("an ordinary sentence with no placeholder");

		expect(reads).toBe(0);
	});
});

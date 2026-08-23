/**
 * WHY. Provider failures were classified in one file and then re-decided at every retry loop, and
 * there were thirteen loops. Each one re-derived from prose whether the thing it caught was worth
 * another attempt, so the halves disagreed and every disagreement was fixed at one call site: a
 * Devin empty body classified transient while the provider predicate refused it, a dead Kimi grant
 * was retried forever because its prose carried no code, a fast-mode entitlement wall arrived as a
 * 429 and was retried against a limit no wait can clear. The turn-retriable set was a hand-kept
 * bitmask twenty lines below the flag table, which is the shape where a flag is added and the mask
 * is not.
 *
 * The class this closes: a failure kind that no family claims, a family that does not say what a
 * stage should do about it, a rule that sets a flag nobody recovers, and a retry decision derived
 * anywhere other than the registry. The variant space is derived from `Flag` and from
 * `ERROR_DOMAINS` at run time, so a seventeenth flag, a new domain or a moved rule turns this red
 * until someone records a decision for it. The one domain that recovers nothing is pinned by name,
 * never by a count.
 *
 * What it does not catch: whether a family's recovery is the RIGHT recovery for that provider
 * failure. That is what the per-incident suites beside this one pin, message by message — this one
 * only proves that exactly one place decides it.
 */
import { describe, expect, it } from "bun:test";
import {
	ERROR_DOMAINS,
	Flag,
	KIND_MASK,
	REPLAY_SAFE_MASK,
	RETRY_VETO_MASK,
	recover,
	retriable,
	stringify,
	TURN_RETRIABLE_MASK,
} from "@veyyon/ai/error/flags";

const STAGES = ["transport", "credential", "turn"] as const;
/** The only domain that claims no flag: it reads a provider's status and code for the families that own them. */
const CLASSIFIER_ONLY = ["provider-http"];

const flagNames = Object.entries(Flag).filter(([name]) => name !== "Class");

describe("the failure-family registry", () => {
	it("gives every failure kind exactly one family that decides its recovery", () => {
		const claims = new Map<number, string[]>();
		for (const domain of ERROR_DOMAINS) {
			for (const flag of domain.recovers) {
				claims.set(flag, [...(claims.get(flag) ?? []), domain.id]);
			}
		}
		const contested = [...claims].filter(([, owners]) => owners.length > 1).map(([flag]) => stringify(flag | 0x1000));
		expect(contested).toEqual([]);

		const unclaimed = flagNames.filter(([, bit]) => !claims.has(bit)).map(([name]) => name);
		expect(unclaimed).toEqual([]);

		const covered = [...claims.keys()].reduce((bits, flag) => bits | flag, 0);
		expect(covered).toBe(KIND_MASK);
	});

	it("declares a recovery for every stage, or claims nothing at all", () => {
		const withoutRecovery = ERROR_DOMAINS.filter(d => d.recovery === undefined).map(d => d.id);
		expect(withoutRecovery).toEqual(CLASSIFIER_ONLY);

		for (const domain of ERROR_DOMAINS) {
			if (domain.recovery === undefined) {
				expect(domain.recovers).toEqual([]);
				continue;
			}
			expect(domain.recovers.length).toBeGreaterThan(0);
			for (const stage of STAGES) expect(domain.recovery[stage].action).toBeString();
		}
	});

	it("keeps every rule in a family that owns one of the flags it sets", () => {
		const owned = ERROR_DOMAINS.flatMap(d => d.recovers).reduce((bits, flag) => bits | flag, 0);
		for (const domain of ERROR_DOMAINS) {
			for (const rule of [...(domain.rules ?? [])]) {
				// No rule sets a bit that no family recovers.
				expect(rule.flags & ~owned).toBe(0);
				// And the file it lives in is one of the families it speaks for. A classifier-only
				// domain speaks for whoever owns the flags its identity rules read.
				if (domain.recovers.length > 0) {
					const mine = domain.recovers.reduce((bits, flag) => bits | flag, 0);
					expect(rule.flags & mine).not.toBe(0);
				}
			}
		}
	});

	it("states why every family and every rule exists", () => {
		const ids = ERROR_DOMAINS.map(d => d.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const domain of ERROR_DOMAINS) {
			expect(domain.why.length).toBeGreaterThan(40);
			for (const rule of [...(domain.rules ?? [])]) expect(rule.why.length).toBeGreaterThan(40);
			for (const rule of [...(domain.classes ?? [])]) expect(rule.why.length).toBeGreaterThan(40);
		}
	});
});

describe("the retry decision is derived from the registry", () => {
	const labels = (mask: number): string[] =>
		flagNames
			.filter(([, bit]) => (mask & bit) !== 0)
			.map(([name]) => name)
			.sort();

	/**
	 * The set that used to be a literal `RETRIABLE_KINDS` bitmask. Pinned by name here so the
	 * derivation cannot quietly widen: a family whose turn recovery becomes `retry` has to be added
	 * to this list on purpose.
	 */
	it("retries at the turn exactly the families that say they do", () => {
		expect(labels(TURN_RETRIABLE_MASK)).toEqual([
			"MalformedFunctionCall",
			"ProviderFinishError",
			"StaleResponsesItem",
			"ThinkingLoop",
			"Transient",
			"UsageLimit",
		]);
		expect(labels(RETRY_VETO_MASK)).toEqual(["ContentBlocked", "TransportRefused"]);
		expect(labels(REPLAY_SAFE_MASK)).toEqual(["MalformedFunctionCall"]);
	});

	it("agrees with the recovery walk for every single failure kind", () => {
		for (const [name, bit] of flagNames) {
			const id = bit | Flag.Class;
			const turnRetries = recover(id, "turn").action === "retry";
			expect(turnRetries).toBe((TURN_RETRIABLE_MASK & bit) !== 0);
			// A kind that retries at the turn is retriable unless something vetoes it.
			if (turnRetries) expect(retriable(id)).toBe(true);
			expect(name).toBeString();
		}
	});

	it("refuses a verdict however the rest of the failure classified", () => {
		const blockedAndTransient = Flag.ContentBlocked | Flag.Transient | Flag.Class;
		expect(retriable(blockedAndTransient)).toBe(false);
		expect(recover(blockedAndTransient, "turn").action).toBe("surface");
	});

	it("retries a call that never parsed even after the turn emitted one", () => {
		const malformed = Flag.MalformedFunctionCall | Flag.Transient | Flag.Class;
		expect(retriable(malformed, { replayUnsafe: true })).toBe(true);
		expect(retriable(Flag.Transient | Flag.Class, { replayUnsafe: true })).toBe(false);
	});

	it("sends a bare timeout to another model and a transport timeout to the same one", () => {
		expect(recover(Flag.Timeout | Flag.Class, "turn").action).toBe("switch-model");
		expect(retriable(Flag.Timeout | Flag.Class)).toBe(false);
		expect(recover(Flag.Timeout | Flag.Transient | Flag.Class, "turn").action).toBe("retry");
		expect(retriable(Flag.Timeout | Flag.Transient | Flag.Class)).toBe(true);
	});

	it("gives a spent quota a different credential and a refused one a refresh", () => {
		expect(recover(Flag.UsageLimit | Flag.Class, "credential").action).toBe("rotate-credential");
		expect(recover(Flag.UsageLimit | Flag.Class, "transport").action).toBe("surface");
		expect(recover(Flag.AuthFailed | Flag.Class, "credential").action).toBe("reauth");
		expect(recover(Flag.AuthFailed | Flag.Class, "turn").action).toBe("surface");
		expect(retriable(Flag.AuthFailed | Flag.Class)).toBe(false);
	});

	it("drops the capability the provider rejected instead of re-sending it", () => {
		expect(recover(Flag.Grammar | Flag.Class, "turn")).toEqual({ action: "degrade", capability: "strict-tools" });
		expect(recover(Flag.FastModeUnsupported | Flag.Class, "turn")).toEqual({
			action: "degrade",
			capability: "fast-mode",
		});
	});

	it("surfaces a failure nobody classified rather than inventing a retry for it", () => {
		expect(recover(0, "turn").action).toBe("surface");
		expect(recover(undefined, "transport").action).toBe("surface");
		expect(recover(429, "turn").action).toBe("surface");
		expect(retriable(429)).toBe(false);
	});

	it("ends a turn somebody stopped without recovering anything", () => {
		for (const flag of [Flag.Abort, Flag.UserInterrupt, Flag.SilentAbort]) {
			for (const stage of STAGES) expect(recover(flag | Flag.Class, stage).action).toBe("abort");
			expect(retriable(flag | Flag.Class)).toBe(false);
		}
	});
});

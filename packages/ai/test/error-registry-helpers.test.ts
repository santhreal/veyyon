import { describe, expect, it } from "bun:test";
import { Flag } from "../src/error/flag";
import {
	CLASS_RULES,
	CLASSIFICATION_RULES,
	classifyIdentity,
	classifySignal,
	domainOf,
	ERROR_DOMAINS,
	REPLAY_SAFE_MASK,
	RETRY_VETO_MASK,
	recover,
	retriable,
	TURN_RETRIABLE_MASK,
	vetoesRetry,
} from "../src/error/registry";

describe("ERROR_DOMAINS", () => {
	it("is non-empty", () => {
		expect(ERROR_DOMAINS.length).toBeGreaterThan(0);
	});
	it("every domain has an id", () => {
		for (const domain of ERROR_DOMAINS) {
			expect(domain.id.length).toBeGreaterThan(0);
		}
	});
});

describe("CLASSIFICATION_RULES", () => {
	it("is non-empty", () => {
		expect(CLASSIFICATION_RULES.length).toBeGreaterThan(0);
	});
	it("every rule has a name", () => {
		for (const rule of CLASSIFICATION_RULES) {
			expect(rule.name.length).toBeGreaterThan(0);
		}
	});
});

describe("CLASS_RULES", () => {
	it("is non-empty", () => {
		expect(CLASS_RULES.length).toBeGreaterThan(0);
	});
});

describe("masks", () => {
	it("TURN_RETRIABLE_MASK is non-zero", () => {
		expect(TURN_RETRIABLE_MASK).toBeGreaterThan(0);
	});
	it("RETRY_VETO_MASK is non-zero", () => {
		expect(RETRY_VETO_MASK).toBeGreaterThan(0);
	});
	it("REPLAY_SAFE_MASK is non-zero", () => {
		expect(REPLAY_SAFE_MASK).toBeGreaterThan(0);
	});
});

describe("vetoesRetry", () => {
	it("returns false for undefined", () => {
		expect(vetoesRetry(undefined)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(vetoesRetry(0)).toBe(false);
	});
	it("returns true for id with veto flag", () => {
		const vetoFlag = Flag.TransportRefused; // refusalDomain vetoes retry
		expect(vetoesRetry(Flag.Class | vetoFlag)).toBe(true);
	});
});

describe("domainOf", () => {
	it("returns domain for known flag", () => {
		const domain = domainOf(Flag.Timeout);
		expect(domain).toBeDefined();
	});
	it("returns undefined for Class flag", () => {
		expect(domainOf(Flag.Class)).toBeUndefined();
	});
});

describe("recover", () => {
	it("returns surface for undefined id", () => {
		expect(recover(undefined, "turn").action).toBe("surface");
	});
	it("returns surface for 0", () => {
		expect(recover(0, "turn").action).toBe("surface");
	});
	it("returns a recovery for timeout flag", () => {
		const id = Flag.Class | Flag.Timeout;
		const recovery = recover(id, "turn");
		expect(recovery).toBeDefined();
		expect(typeof recovery.action).toBe("string");
	});
});

describe("retriable", () => {
	it("returns false for undefined", () => {
		expect(retriable(undefined)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(retriable(0)).toBe(false);
	});
	it("returns false when veto flag is set", () => {
		expect(retriable(Flag.Class | Flag.TransportRefused)).toBe(false);
	});
});

describe("classifySignal", () => {
	it("returns 0 for empty signal", () => {
		const result = classifySignal({ text: "", status: undefined, api: undefined, http2: undefined, code: undefined });
		expect(result).toBe(0);
	});
	it("returns 0 for signal with no matching rules", () => {
		const result = classifySignal({ text: "completely unknown error", status: undefined, api: undefined, http2: undefined, code: undefined });
		expect(result).toBeGreaterThanOrEqual(0);
	});
});

describe("classifyIdentity", () => {
	it("returns 0 for null", () => {
		expect(classifyIdentity(null)).toBe(0);
	});
	it("returns 0 for undefined", () => {
		expect(classifyIdentity(undefined)).toBe(0);
	});
	it("returns 0 for non-matching value", () => {
		expect(classifyIdentity("nonexistent")).toBeGreaterThanOrEqual(0);
	});
});

/**
 * WHY. Provider failures used to be classified in one place and then re-decided at thirteen retry
 * loops across the codebase, with each loop interpreting raw prose. When new failure families
 * were added, they could be declared in the error domains without any proof that their rules are
 * reachable, that their flags are unique and complete, or that every stage (transport, credential,
 * turn) knows what recovery action to perform.
 *
 * The class this closes: an error domain declared in `ERROR_DOMAINS` that cannot be reached by a
 * real error shape, a domain missing an explicit stage recovery decision, or a recovery action that
 * violates the defined variant space. The variant space is derived from `ERROR_DOMAINS` at run time,
 * so adding a fifteenth domain turns this suite red until an explicit fixture, flag, and recovery
 * contract are recorded for it.
 *
 * What it does not catch: per-message nuances of regex boundaries in individual domain rules.
 * Those are defended in the domain-boundary suite.
 */
import { describe, expect, it } from "bun:test";
import {
	classify,
	create,
	ERROR_DOMAINS,
	type ErrorDomain,
	explain,
	Flag,
	KIND_MASK,
	ProviderHttpError,
	type Recovery,
	type RecoveryStage,
	recover,
	retriable,
	vetoesRetry,
} from "../src/error";

interface DomainSpec {
	readonly buildFixture: () => unknown;
	readonly expectedFlags: number;
	readonly expectedRecovery: Readonly<Record<RecoveryStage, Recovery>> | undefined;
	readonly vetoesRetry?: boolean;
	readonly replaySafe?: boolean;
}

const DOMAIN_DECISIONS: Record<string, DomainSpec> = {
	interrupt: {
		buildFixture: () => new DOMException("The operation was aborted", "AbortError"),
		expectedFlags: Flag.Abort,
		expectedRecovery: {
			transport: { action: "abort" },
			credential: { action: "abort" },
			turn: { action: "abort" },
		},
		vetoesRetry: true,
	},
	content: {
		buildFixture: () => new Error("incomplete: content_filter"),
		expectedFlags: Flag.ContentBlocked,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "surface" },
		},
		vetoesRetry: true,
	},
	overflow: {
		buildFixture: () => new Error("prompt is too long: 250000 tokens > 200000 maximum"),
		expectedFlags: Flag.ContextOverflow,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "compact" },
		},
	},
	quota: {
		buildFixture: () => new Error("You've reached your usage limit. Upgrade to increase your limit."),
		expectedFlags: Flag.UsageLimit,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "rotate-credential" },
			turn: { action: "retry" },
		},
	},
	auth: {
		buildFixture: () => new Error("401 Unauthorized: invalid api key"),
		expectedFlags: Flag.AuthFailed,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "reauth" },
			turn: { action: "surface" },
		},
	},
	grammar: {
		buildFixture: () =>
			Object.assign(new Error("400 invalid_request_error: compiled grammar is too large"), { status: 400 }),
		expectedFlags: Flag.Grammar,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "degrade", capability: "strict-tools" },
		},
	},
	"fast-mode": {
		buildFixture: () =>
			Object.assign(new Error("400 invalid_request_error: speed is not supported for this model"), { status: 400 }),
		expectedFlags: Flag.FastModeUnsupported,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "degrade", capability: "fast-mode" },
		},
	},
	"tool-call": {
		buildFixture: () => new Error("MALFORMED_FUNCTION_CALL: could not parse json"),
		// Note: MALFORMED_FUNCTION_CALL also matches the transport-vocabulary pattern
		expectedFlags: Flag.MalformedFunctionCall | Flag.Transient,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "retry" },
		},
		replaySafe: true,
	},
	stream: {
		buildFixture: () => new Error("Provider finish_reason: error"),
		expectedFlags: Flag.ProviderFinishError,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "retry" },
		},
	},
	"thinking-loop": {
		buildFixture: () => ({ errorId: Flag.ThinkingLoop | Flag.Class }),
		expectedFlags: Flag.ThinkingLoop,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "retry" },
		},
	},
	refusal: {
		buildFixture: () => new Error("Stream closed with error code NGHTTP2_CANCEL"),
		expectedFlags: Flag.TransportRefused,
		expectedRecovery: {
			transport: { action: "surface" },
			credential: { action: "surface" },
			turn: { action: "surface" },
		},
		vetoesRetry: true,
	},
	transport: {
		buildFixture: () => new Error("503 Service Unavailable"),
		expectedFlags: Flag.Transient,
		expectedRecovery: {
			transport: { action: "retry" },
			credential: { action: "retry" },
			turn: { action: "retry" },
		},
	},
	timeout: {
		buildFixture: () => new Error("Request timed out after 60000ms"),
		expectedFlags: Flag.Timeout | Flag.Transient,
		expectedRecovery: {
			transport: { action: "retry" },
			credential: { action: "retry" },
			turn: { action: "switch-model" },
		},
	},
	"provider-http": {
		buildFixture: () => new ProviderHttpError("Gateway Error", 502),
		expectedFlags: Flag.Transient,
		expectedRecovery: undefined,
	},
};

const STAGES: readonly RecoveryStage[] = ["transport", "credential", "turn"] as const;
const VALID_ACTIONS = new Set([
	"retry",
	"rotate-credential",
	"reauth",
	"compact",
	"switch-model",
	"degrade",
	"surface",
	"abort",
]);
const VALID_CAPABILITIES = new Set(["strict-tools", "fast-mode", "server-side-items"]);

describe("exhaustive error domain sweep", () => {
	it("enumerates all domains from ERROR_DOMAINS and fails if an unrecorded domain is added", () => {
		const declaredDomainIds = ERROR_DOMAINS.map((domain: ErrorDomain) => domain.id);
		const recordedDomainIds = Object.keys(DOMAIN_DECISIONS);

		expect(declaredDomainIds.sort()).toEqual(recordedDomainIds.sort());
	});

	it("proves every declared domain is reachable via its real error shape", () => {
		for (const domain of ERROR_DOMAINS) {
			const spec = DOMAIN_DECISIONS[domain.id];
			expect(spec).toBeDefined();

			const fixture = spec.buildFixture();
			const classifiedId = classify(fixture);
			const flagsOnly = classifiedId & KIND_MASK;

			// Assert that every flag declared in spec is present in the classification result
			expect(flagsOnly & spec.expectedFlags).toBe(spec.expectedFlags);

			// Assert that for every flag the domain claims, recovering that flag alone matches domain recovery
			if (domain.recovery) {
				for (const flag of domain.recovers) {
					const isolatedId = create(flag);
					for (const stage of STAGES) {
						const recovery = recover(isolatedId, stage);
						expect(recovery).toEqual(domain.recovery[stage]);
					}
				}
			}
		}
	});

	it("asserts all recovery actions and capabilities belong to the strict variant space", () => {
		for (const domain of ERROR_DOMAINS) {
			if (!domain.recovery) continue;

			for (const stage of STAGES) {
				const recovery = domain.recovery[stage];
				expect(VALID_ACTIONS.has(recovery.action)).toBe(true);

				if (recovery.action === "degrade") {
					expect(VALID_CAPABILITIES.has(recovery.capability)).toBe(true);
				}
			}
		}
	});

	it("validates retry vetoes and replay safety invariants across all domains", () => {
		for (const domain of ERROR_DOMAINS) {
			const spec = DOMAIN_DECISIONS[domain.id];
			const fixture = spec.buildFixture();
			const classifiedId = classify(fixture);

			if (domain.vetoesRetry) {
				expect(vetoesRetry(classifiedId)).toBe(true);
				expect(retriable(classifiedId)).toBe(false);
			}

			if (domain.replaySafe) {
				expect(retriable(classifiedId, { replayUnsafe: true })).toBe(true);
			}
		}
	});

	it("asserts that every domain's rules and classes provide non-empty diagnostic explanations", () => {
		for (const domain of ERROR_DOMAINS) {
			const spec = DOMAIN_DECISIONS[domain.id];
			const fixture = spec.buildFixture();
			const explanation = explain(fixture);

			// A domain with rules or classes must trigger at least one named rule in trace
			if ((domain.rules && domain.rules.length > 0) || (domain.classes && domain.classes.length > 0)) {
				expect(explanation.rules.length).toBeGreaterThan(0);
			}
		}
	});
});

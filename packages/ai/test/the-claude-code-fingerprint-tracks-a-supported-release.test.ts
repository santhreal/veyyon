/**
 * WHY THIS SUITE EXISTS.
 *
 * The Anthropic OAuth wire carries a Claude Code version in three places: the `cc_version` field of the
 * `x-anthropic-billing-header` system block, the `claude-cli/<version>` user-agent, and the
 * `claude-code/<version>` OAuth bootstrap user-agent. `/v1/messages` reads that version and rejects the
 * request when it is older than the minimum a requested model requires:
 *
 *     400 invalid_request_error, error_code=claude_code_version_too_old
 *     "Claude Code <sent> does not support this model; version <minimum> or newer is required."
 *
 * The failure is total for the affected models and it arrives with no local symptom beforehand: the constant
 * is valid, every internal assertion about it passes, and the request is well formed. It goes stale by the
 * calendar rather than by an edit, so nothing in this repository moves when it breaks.
 *
 * THE CLASS THIS CLOSES. A fingerprint version that sits below a minimum the API has already been observed to
 * enforce, and an `agent-sdk/<version>` that stops tracking the CLI release it is paired with. Both are
 * static facts about the constants, so both are checkable without a network call.
 *
 * WHAT IT DOES NOT CATCH. The floor is the newest minimum the API has been seen to enforce, not the one it
 * enforces today. When Anthropic raises the minimum again, these cases stay green and the request still
 * fails 400 — the raised floor is recorded here as part of that fix. Nor does this suite prove the version
 * reaches the wire; `anthropic-alignment.test.ts` asserts the emitted billing header and user-agents, and
 * `claude-code-identity-has-one-owner.test.ts` proves there is exactly one copy of the constant to bump.
 */

import { describe, expect, it } from "bun:test";
import { claudeAgentSdkVersion } from "@veyyon/ai/providers/anthropic";
import { CLAUDE_CODE_VERSION } from "@veyyon/catalog/wire/anthropic";

/**
 * The highest `claude_code_version_too_old` minimum the API has been observed to demand. Raise it, with the
 * version bump, whenever a 400 names a newer one.
 */
const OBSERVED_API_MINIMUM = "2.1.251";

/** The release line the Agent SDK publishes under; its patch component tracks the CLI's. */
const AGENT_SDK_LINE = "0.3";

function versionOrder(left: string, right: string): number {
	const l = left.split(".").map(Number);
	const r = right.split(".").map(Number);
	for (let i = 0; i < Math.max(l.length, r.length); i++) {
		const diff = (l[i] ?? 0) - (r[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
}

describe("the Claude Code fingerprint tracks a supported release", () => {
	/**
	 * The case that fails on the defect: a version at or above the minimum the API enforces for current
	 * models. 2.1.165 was below it and every request for those models came back 400.
	 */
	it("is not below the minimum the API has been observed to enforce", () => {
		expect(
			versionOrder(CLAUDE_CODE_VERSION, OBSERVED_API_MINIMUM),
			`CLAUDE_CODE_VERSION ${CLAUDE_CODE_VERSION} is older than ${OBSERVED_API_MINIMUM}, which /v1/messages rejects with claude_code_version_too_old`,
		).toBeGreaterThanOrEqual(0);
	});

	/**
	 * The user-agent sends `claude-cli/<cli> (external, local-agent, agent-sdk/<sdk>)`, and upstream ships the
	 * two in lockstep: CLI 2.1.257 with SDK 0.3.257. Bumping one alone produces a pair that no real client
	 * ever sent, which is the inconsistency the fingerprint exists to avoid.
	 */
	it("pairs the agent-sdk version with the CLI patch it ships beside", () => {
		const [, , cliPatch] = CLAUDE_CODE_VERSION.split(".");
		expect(claudeAgentSdkVersion).toBe(`${AGENT_SDK_LINE}.${cliPatch}`);
	});

	/**
	 * NON-VACUITY for the comparator, which is the whole content of the floor case above. A comparator that
	 * returned 0 for everything, or compared component strings rather than numbers, would pass the floor case
	 * on any version at all — including the 2.1.165 that produced the 400.
	 */
	it.each([
		["2.1.165", "2.1.251", -1],
		["2.1.251", "2.1.251", 0],
		["2.1.257", "2.1.251", 1],
		["2.1.9", "2.1.10", -1],
		["2.2.0", "2.1.999", 1],
		["3.0", "2.1.251", 1],
	] as const)("orders %s against %s", (left, right, expected) => {
		expect(versionOrder(left, right)).toBe(expected);
	});
});

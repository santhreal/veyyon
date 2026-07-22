/**
 * resolveSubscriptionPostAction full truth table.
 */
import { describe, expect, it } from "bun:test";
import { resolveSubscriptionPostAction } from "../src/mcp/manager";

describe("resolveSubscriptionPostAction truth table", () => {
	const epochs = [0, 1, 5, 99];
	for (const cur of epochs) {
		for (const sub of epochs) {
			it(`notif=false cur=${cur} sub=${sub} -> rollback`, () => {
				expect(resolveSubscriptionPostAction(false, cur, sub)).toBe("rollback");
			});
			it(`notif=true cur=${cur} sub=${sub}`, () => {
				const want = cur === sub ? "apply" : "ignore";
				expect(resolveSubscriptionPostAction(true, cur, sub)).toBe(want);
			});
		}
	}
});

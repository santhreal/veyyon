/**
 * WHY THIS EXISTS. A usage report crosses the broker wire inside `/v1/usage`, and the schema it
 * is validated against was written twice: once at module scope in `packages/ai/src/usage.ts` and
 * once inside `wireSchemas()` in `packages/ai/src/auth-broker/wire-schemas.ts`. The two copies
 * were identical by hand, which is how #3268 happened -- a report-level `notes` field declared in
 * one copy and missing from the other, so the field survived a local read and vanished across the
 * broker. Both copies now come from `usageWireSchemas()` in `packages/ai/src/usage/report-wire.ts`.
 *
 * THE CLASS THIS CLOSES. Not "notes goes missing" but "the two validators for one payload
 * disagree about a field". The identity case below is what closes it: the broker's report schema
 * must BE the owner's object, so a second declaration cannot be introduced while this passes.
 *
 * WHAT IT DOES NOT CATCH. A field missing from the ONE owner is missing everywhere at once, and
 * nothing here knows what fields a provider will add next. It also does not test the transport;
 * `auth-broker` client tests own that.
 */

import { describe, expect, it } from "bun:test";
import { wireSchemas } from "@veyyon/ai/auth-broker/wire-schemas";
import { usageWireSchemas } from "@veyyon/ai/usage/report-wire";
import { type } from "arktype";

const DISCLAIMER = "Veyyon-observed spend only; OpenCode usage outside Veyyon is not included.";

function reportWithNotes() {
	return {
		provider: "opencode-go",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "rolling-5h",
				label: "5 Hour limit",
				scope: { provider: "opencode-go", windowId: "rolling-5h" },
				window: { id: "rolling-5h", label: "5 Hour", durationMs: 5 * 3_600_000 },
				amount: { used: 3, limit: 12, remaining: 9, usedFraction: 0.25, remainingFraction: 0.75, unit: "usd" },
				status: "ok",
			},
		],
		notes: [DISCLAIMER],
		metadata: { planType: "OpenCode Go" },
	};
}

describe("the usage report wire has one owner", () => {
	it("validates a report with provider-level notes and keeps them", () => {
		const validated = usageWireSchemas().report(reportWithNotes());

		expect(validated).not.toBeInstanceOf(type.errors);
		expect(validated).toHaveProperty("notes", [DISCLAIMER]);
	});

	it("carries those notes through the broker envelope's reject gate", () => {
		const validated = wireSchemas().usageResponseSchema({
			generatedAt: Date.now(),
			reports: [reportWithNotes()],
		});

		if (validated instanceof type.errors) {
			throw new Error(`expected a valid response, got ${validated.summary}`);
		}
		expect(validated.reports[0]).toHaveProperty("notes", [DISCLAIMER]);
	});

	/**
	 * The one case that makes divergence impossible rather than merely absent today: the broker
	 * does not declare a report, it embeds the owner's. Re-declaring a local copy fails here even
	 * when the copy is field-for-field correct, which is the state the two files were in before.
	 */
	it("embeds the owner's report schema in the broker envelope rather than a copy of it", () => {
		const owner = usageWireSchemas();
		const envelope = wireSchemas();

		expect(envelope.usageResponseSchema.get("reports").expression).toBe(owner.report.array().expression);
	});

	/**
	 * The broker validates a response per request, so the schemas are built once and reused. A
	 * rebuild per call would put arktype's construction cost on every usage poll.
	 */
	it("builds the vocabulary once and hands the same schemas back", () => {
		expect(usageWireSchemas()).toBe(usageWireSchemas());
	});

	/**
	 * The envelope's `"+": "reject"` is what the notes defect was hiding behind: an unknown field
	 * at envelope level is an error rather than something quietly dropped, so a field added on one
	 * side of the wire and not the other is loud.
	 */
	it("refuses an envelope field it does not declare", () => {
		const validated = wireSchemas().usageResponseSchema({
			generatedAt: Date.now(),
			reports: [],
			unexpected: "field",
		});

		expect(validated).toBeInstanceOf(type.errors);
	});
});

import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@veyyon/catalog/models";
import { createProviderErrorMessage } from "../src/providers/error-message";
import type { Api, Model } from "../src/types";

const model = getBundledModel("openai", "gpt-4o-mini") as Model<Api>;

// createProviderErrorMessage synthesizes the assistant turn a provider emits
// when a request throws: the error text carried verbatim, the model identity
// preserved, and a zeroed usage/cost envelope so a failed call bills nothing.
describe("createProviderErrorMessage", () => {
	it("renders the error text into an assistant text turn stamped with the model identity", () => {
		const message = createProviderErrorMessage(model, new Error("upstream 503"));
		expect(message.role).toBe("assistant");
		expect(message.content).toEqual([{ type: "text", text: "upstream 503" }]);
		expect(message.api).toBe(model.api);
		expect(message.provider).toBe(model.provider);
		expect(message.model).toBe(model.id);
		expect(message.stopReason).toBe("error");
		expect(typeof message.timestamp).toBe("number");
	});

	it("stringifies non-Error throwables through errorMessage", () => {
		expect(createProviderErrorMessage(model, "boom").content[0].text).toBe("boom");
		expect(createProviderErrorMessage(model, { code: 42 }).content[0].text).toBe("[object Object]");
	});

	it("bills nothing: every usage and cost field is zero", () => {
		const { usage } = createProviderErrorMessage(model, new Error("x"));
		expect(usage.input).toBe(0);
		expect(usage.output).toBe(0);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(0);
		expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});
});

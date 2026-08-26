/**
 * WHY: the vendor a model draws from was inferred from a three-entry substring table
 * (gemini / claude / gpt|codex|o1). Every other real model id — Mistral, DeepSeek, Llama,
 * Qwen, an OpenRouter path — fell through to null, the per-vendor quota check reported
 * "not checked", and the run proceeded straight into RESOURCE_EXHAUSTED after paying for
 * container setup.
 *
 * The class closed here is "a vendor the catalog knows reads as unplaceable". Resolution is
 * swept from `CATALOG_PROVIDERS` at run time, so a provider added to the catalog whose default
 * model resolves to nothing turns this suite red instead of degrading a run into an unchecked
 * one. It also pins the split the fix rests on: `modelVendor` is a query that answers null, and
 * `requireModelVendor` is the refusal the preflight makes at its decision point. Collapsing the
 * two — making the query throw — makes `exhaustedPoolFor` throw on an id it merely could not
 * place, which is a different defect wearing the fix's clothes.
 *
 * What it does not catch: whether a resolved vendor names the pool segment a given gateway
 * actually reports (that is `exhaustedPoolFor`'s own suite), and vendor spellings for providers
 * absent from the catalog.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import {
	type CredentialProbe,
	exhaustedPoolFor,
	modelVendor,
	requireModelVendor,
} from "../../../src/core/auth-preflight";
import { requireStagedAuthCanServeToken } from "../../../src/suites/deep-swe/src/runner/preflight";

describe("an unresolvable model vendor refuses the preflight", () => {
	it("refuses by name, and says where to verify the id", () => {
		const unknownModel = "custom-unlisted-provider/mystery-model-v1";
		expect(() => requireModelVendor(unknownModel)).toThrow(
			`Cannot resolve model vendor for "${unknownModel}". Preflight refused: verify model id against @veyyon/catalog.`,
		);
	});

	it("keeps the pool query answering null rather than throwing on an id it cannot place", () => {
		const probes: CredentialProbe[] = [
			{
				provider: "openai",
				ok: true,
				report: { limits: [{ id: "openai:primary", status: "exhausted" }] },
			},
		];
		// "not checked", which the preflight reports out loud before refusing — not an
		// exception thrown from a lookup, and not a silent "fine".
		expect(exhaustedPoolFor(probes, "unknown-vendor-id")).toBeNull();
		expect(modelVendor("unknown-vendor-id")).toBeNull();
	});
});

describe("the preflight refuses a model whose pool it cannot check", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	/** An empty staged store: every verdict below is fatal, so the MESSAGE is what discriminates. */
	function emptyAuthDb(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-preflight-vendor-"));
		cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
		return path.join(dir, "auth-agent.db");
	}

	it("names the model it could not place, before it ever reports on credentials", async () => {
		await expect(
			requireStagedAuthCanServeToken("custom-unlisted-provider/mystery-model-v1", false, emptyAuthDb()),
		).rejects.toThrow(/cannot resolve the upstream vendor for model "custom-unlisted-provider\/mystery-model-v1"/);
	});

	/**
	 * The discriminator: the same empty store with a placeable model still fails, on the
	 * credential verdict rather than on the vendor. A refusal that fired for both would prove
	 * nothing about which branch threw.
	 */
	it("gets past the vendor check for a model it can place", async () => {
		await expect(requireStagedAuthCanServeToken("anthropic/claude-3-7-sonnet", false, emptyAuthDb())).rejects.toThrow(
			/staged auth DB|credential/i,
		);
	});

	/** A dry run reports the unplaceable id and continues, matching the spent-quota path. */
	it("reports but does not refuse on a dry run", async () => {
		await expect(
			requireStagedAuthCanServeToken("custom-unlisted-provider/mystery-model-v1", true, emptyAuthDb()),
		).rejects.toThrow(/staged auth DB|credential/i);
	});
});

describe("every vendor the catalog knows is placeable", () => {
	it("resolves the default model of every registered provider", () => {
		expect(CATALOG_PROVIDERS.length).toBeGreaterThan(0);
		const unplaceable = CATALOG_PROVIDERS.filter(provider => modelVendor(provider.defaultModel) === null).map(
			provider => `${provider.id} -> ${provider.defaultModel}`,
		);
		expect(unplaceable).toEqual([]);
	});

	it("places a router-namespaced id by the vendor inside it, not by the router", () => {
		const cases: Array<{ model: string; vendor: string }> = [
			{ model: "anthropic/claude-3-7-sonnet", vendor: "anthropic" },
			{ model: "google/gemini-2.5-pro", vendor: "google" },
			{ model: "openai/gpt-4o", vendor: "openai" },
			{ model: "openrouter/anthropic/claude-3.5-sonnet", vendor: "anthropic" },
			{ model: "openrouter/mistralai/mistral-large", vendor: "mistral" },
			{ model: "openrouter/deepseek/deepseek-chat", vendor: "deepseek" },
			{ model: "openrouter/meta-llama/llama-3.3-70b-instruct", vendor: "meta" },
			{ model: "openrouter/qwen/qwen-2.5-coder-32b-instruct", vendor: "qwen" },
			{ model: "mistral/mistral-large-latest", vendor: "mistral" },
			{ model: "deepseek/deepseek-coder", vendor: "deepseek" },
			{ model: "meta-llama/llama-3.1-405b", vendor: "meta" },
			{ model: "qwen/qwen-2.5-coder-32b", vendor: "qwen" },
			{ model: "xai/grok-2-1212", vendor: "xai" },
			{ model: "moonshotai/kimi-k2.6", vendor: "moonshot" },
			{ model: "zai-org/glm-4.7", vendor: "zhipu" },
			{ model: "minimax/m2-pro", vendor: "minimax" },
			{ model: "xiaomi/mimo-1.0", vendor: "xiaomi" },
		];

		expect(cases.map(({ model }) => modelVendor(model))).toEqual(cases.map(({ vendor }) => vendor));
	});
});

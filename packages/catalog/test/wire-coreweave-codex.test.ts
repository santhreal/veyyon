import { describe, expect, it } from "bun:test";
import { getCodexAccountId } from "../src/wire/codex";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
	resolveCoreWeaveProject,
} from "../src/wire/coreweave";

describe("resolveCoreWeaveProject", () => {
	it("prefers COREWEAVE_PROJECT, then WANDB_INFERENCE_PROJECT", () => {
		expect(resolveCoreWeaveProject({ COREWEAVE_PROJECT: "team/proj", WANDB_INFERENCE_PROJECT: "other" })).toBe(
			"team/proj",
		);
		expect(resolveCoreWeaveProject({ WANDB_INFERENCE_PROJECT: "infer/proj" })).toBe("infer/proj");
	});

	it("uses WANDB_PROJECT as-is when entity-qualified, else joins WANDB_ENTITY", () => {
		expect(resolveCoreWeaveProject({ WANDB_PROJECT: "entity/proj" })).toBe("entity/proj");
		expect(resolveCoreWeaveProject({ WANDB_PROJECT: "proj", WANDB_ENTITY: "team" })).toBe("team/proj");
		expect(resolveCoreWeaveProject({ WANDB_PROJECT: "proj" })).toBeUndefined();
	});

	it("treats blank/whitespace values as unset", () => {
		expect(
			resolveCoreWeaveProject({ COREWEAVE_PROJECT: "  ", WANDB_PROJECT: " proj ", WANDB_ENTITY: " team " }),
		).toBe("team/proj");
		expect(resolveCoreWeaveProject({})).toBeUndefined();
	});
});

describe("coreWeave project headers", () => {
	it("builds the OpenAI-Project header only when a project resolves", () => {
		expect(coreWeaveProjectHeaders({ COREWEAVE_PROJECT: "team/proj" })).toEqual({ "OpenAI-Project": "team/proj" });
		expect(coreWeaveProjectHeaders({})).toBeUndefined();
	});

	it("hasCoreWeaveProjectHeader matches case-insensitively and ignores blanks", () => {
		expect(hasCoreWeaveProjectHeader({ "openai-project": "x" })).toBe(true);
		expect(hasCoreWeaveProjectHeader({ [COREWEAVE_PROJECT_HEADER]: "  " })).toBe(false);
		expect(hasCoreWeaveProjectHeader({ other: "x" })).toBe(false);
	});

	it("removeBlankCoreWeaveProjectHeaders strips only blank project headers in place", () => {
		const headers: Record<string, string> = { "OpenAI-Project": " ", "openai-project": "", keep: "" };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers).toEqual({ keep: "" });
		const kept: Record<string, string> = { "OpenAI-Project": "team/proj" };
		removeBlankCoreWeaveProjectHeaders(kept);
		expect(kept).toEqual({ "OpenAI-Project": "team/proj" });
	});
});

describe("getCodexAccountId", () => {
	function jwtWith(payload: object): string {
		const body = Buffer.from(JSON.stringify(payload)).toString("base64");
		return `header.${body}.signature`;
	}

	it("extracts the chatgpt account id from the auth claim", () => {
		const token = jwtWith({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
		expect(getCodexAccountId(token)).toBe("acct-123");
	});

	it("returns undefined for malformed tokens and missing claims", () => {
		expect(getCodexAccountId("not-a-jwt")).toBeUndefined();
		expect(getCodexAccountId("a.b")).toBeUndefined();
		expect(getCodexAccountId(`h.${Buffer.from("not json").toString("base64")}.s`)).toBeUndefined();
		expect(getCodexAccountId(jwtWith({ other: 1 }))).toBeUndefined();
		expect(getCodexAccountId(jwtWith({ "https://api.openai.com/auth": {} }))).toBeUndefined();
	});
});

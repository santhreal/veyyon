/**
 * The xAI-missing-credential copy is for the model, not a TUI submenu.
 *
 * WHY THIS SUITE EXISTS. image-gen and tts used to disagree: one named a
 * reachable `veyyon auth-broker login xai-oauth` command, the other said
 * `Run /login -> xAI Grok OAuth`. `/login` has no textMode, so ACP and
 * `--print` cannot follow it. The provider id is `xai-oauth`; `xai`
 * has no login flow. A missing credential is not a retryable tool error.
 */
import { describe, expect, it } from "bun:test";
import { missingXAICredentialsMessage } from "@veyyon/coding-agent/lib/xai-http";

describe("missingXAICredentialsMessage is one owner", () => {
	it("interpolates the capability and does not drop surrounding punctuation", () => {
		const msg = missingXAICredentialsMessage("speech cannot be synthesized");
		expect(msg.startsWith("No xAI credentials, so speech cannot be synthesized. ")).toBe(true);
	});

	it("names veyyon auth-broker login xai-oauth, never login xai", () => {
		const msg = missingXAICredentialsMessage("image generation cannot run");
		expect(msg).toContain("veyyon auth-broker login xai-oauth");
		expect(msg).not.toContain("auth-broker login xai ");
		expect(msg).not.toContain("login xai`");
	});

	it("mentions /login only as an interactive session path, not as the only fix", () => {
		const msg = missingXAICredentialsMessage("speech cannot be synthesized");
		expect(msg).toContain("XAI_API_KEY");
		expect(msg).toContain("`/login` in an interactive veyyon session");
		expect(msg).not.toContain("Run /login ->");
		expect(msg).not.toContain("xAI Grok OAuth");
	});

	it("tells the model not to retry the tool", () => {
		const msg = missingXAICredentialsMessage("speech cannot be synthesized");
		expect(msg).toContain("Do not retry this tool until one of those is done");
		expect(msg).toContain("report the missing credential instead");
	});

	it("does not leak a second copy that still says SuperGrok without the broker command", () => {
		const msg = missingXAICredentialsMessage("x");
		expect(msg).toContain("SuperGrok or X Premium+");
		expect(msg.indexOf("veyyon auth-broker login xai-oauth")).toBeGreaterThan(0);
	});
});

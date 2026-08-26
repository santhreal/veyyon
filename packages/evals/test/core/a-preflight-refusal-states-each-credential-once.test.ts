/**
 * WHY: a `--dry-run` against a host with no network printed forty lines per suite. Each
 * failing credential contributed the provider client's whole error — one sentence, then
 * `; stack=` and a dozen `    at async …` frames — and the staged-auth refusal was printed
 * by the preflight and then thrown, so the caller rendered every one of those lines a
 * second time. The instruction that ends the message, that a login is needed, was the
 * least visible thing in the output.
 *
 * The class this closes: a preflight verdict that carries a provider's stack frames, and a
 * refusal that is both printed and thrown. Every verdict line is built by
 * `summarizeCredentialReason`, so a new failure shape is collapsed by the same rule, and
 * the console is asserted silent on each refusing path while the two continuing paths are
 * asserted to still print — a spy that never sees anything cannot tell the two apart.
 *
 * What it does not catch: how a caller renders the error it caught (the veyyon adapter
 * prefixes it with the staged path, proved by its own preflight suite), and whether a
 * probe's reason is accurate, which belongs to the credential store.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import {
	type CredentialProbe,
	decideAuthPreflight,
	describeAuthPreflightFailure,
	requireStagedAuthCanServeToken,
	summarizeCredentialReason,
} from "../../src/core/auth-preflight";

const STAGED = "/bench/assets/auth-agent.db";

/** The shape a provider client actually reports: one sentence, a stack tail, indented frames. */
const OAUTH_FAILURE = [
	"oauth refresh failed: Anthropic token refresh request failed.",
	" url=https://api.anthropic.com/v1/oauth/token;",
	" details=TypeError: getaddrinfo ETIMEOUT api.anthropic.com;",
	" code=ETIMEOUT; errno=12;",
	" stack=TypeError: getaddrinfo ETIMEOUT api.anthropic.com\n",
	"    at async postJson (packages/ai/src/registry/oauth/anthropic.ts:53:15)\n",
	"    at async checkCredentials (packages/ai/src/auth-storage.ts:4881:36)",
].join("");

describe("a credential failure as a verdict line", () => {
	it("keeps the cause and drops the stack tail the provider appended", () => {
		const line = summarizeCredentialReason(OAUTH_FAILURE);
		expect(line).toContain("Anthropic token refresh request failed");
		expect(line).toContain("getaddrinfo ETIMEOUT api.anthropic.com");
		expect(line).not.toContain("stack=");
		expect(line).not.toContain("at async");
		expect(line.split("\n")).toHaveLength(1);
	});

	it("drops frames from a reason that is nothing but a stack", () => {
		const line = summarizeCredentialReason(
			"TypeError: fetch failed\n    at async foo (a.ts:1:1)\n    at bar (b.ts:2:2)",
		);
		expect(line).toBe("TypeError: fetch failed");
	});

	it("collapses the whitespace a wrapped message carries", () => {
		expect(summarizeCredentialReason("token   expired\t\tan hour ago; stack=x")).toBe("token expired an hour ago");
	});

	it("leaves a reason that is already one line alone", () => {
		expect(summarizeCredentialReason("refresh token rejected")).toBe("refresh token rejected");
	});

	it("reports a blank reason rather than an empty line", () => {
		expect(summarizeCredentialReason("   \n  ")).toBe("no reason reported");
		expect(summarizeCredentialReason("")).toBe("no reason reported");
	});
});

describe("the staged-auth refusal", () => {
	it("spends one line per credential, whatever the provider reported", () => {
		const probes: CredentialProbe[] = [
			{ provider: "anthropic", ok: false, reason: OAUTH_FAILURE, email: "a@b.co" },
			{ provider: "kimi-code", ok: false, reason: "oauth refresh failed: getaddrinfo ETIMEOUT auth.kimi.com" },
			{ provider: "nous-research", ok: false, reason: OAUTH_FAILURE.replace("Anthropic", "Nous Portal") },
		];
		const message = describeAuthPreflightFailure(decideAuthPreflight(probes), STAGED);
		const lines = message.split("\n");

		// One header naming the staged path, one line per failing credential, one instruction.
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain(STAGED);
		expect(lines[1]).toBe(
			"  anthropic (a@b.co): oauth refresh failed: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; details=TypeError: getaddrinfo ETIMEOUT api.anthropic.com; code=ETIMEOUT; errno=12",
		);
		expect(lines[2]).toBe("  kimi-code: oauth refresh failed: getaddrinfo ETIMEOUT auth.kimi.com");
		expect(lines[3]).toContain("nous-research: oauth refresh failed: Nous Portal");
		expect(lines[4]).toContain("logging in again");
		expect(message).not.toContain("at async");
	});
});

describe("a refusing preflight", () => {
	const temps: TempDir[] = [];
	let errors: string[] = [];

	afterEach(async () => {
		for (const temp of temps.splice(0)) await temp.remove();
		errors = [];
	});

	function captureConsole(): void {
		errors = [];
		const capture = (...args: unknown[]): void => {
			errors.push(args.map(String).join(" "));
		};
		spyOn(console, "error").mockImplementation(capture);
		spyOn(console, "warn").mockImplementation(capture);
	}

	/** An empty staged store: every verdict below is fatal, so the throw is the whole output. */
	async function emptyAuthDb(): Promise<string> {
		const temp = await TempDir.create("evals-preflight-once-");
		temps.push(temp);
		return path.join(temp.path(), "auth-agent.db");
	}

	it("throws the verdict instead of printing it as well", async () => {
		captureConsole();
		const dbPath = await emptyAuthDb();
		await expect(requireStagedAuthCanServeToken("anthropic/claude-3-7-sonnet", false, dbPath)).rejects.toThrow(
			/staged auth DB/i,
		);
		expect(errors).toEqual([]);
	});

	it("throws an unplaceable vendor once, on the path that refuses", async () => {
		captureConsole();
		const dbPath = await emptyAuthDb();
		await expect(
			requireStagedAuthCanServeToken("custom-unlisted-provider/mystery-model-v1", false, dbPath),
		).rejects.toThrow(/cannot resolve the upstream vendor/);
		expect(errors).toEqual([]);
	});

	/**
	 * The discriminator. A dry run continues past an unplaceable vendor, so it has to say
	 * so; if this printed nothing the assertions above would hold for a preflight that had
	 * simply stopped reporting.
	 */
	it("still reports the checks a dry run continued past", async () => {
		captureConsole();
		const dbPath = await emptyAuthDb();
		await expect(
			requireStagedAuthCanServeToken("custom-unlisted-provider/mystery-model-v1", true, dbPath),
		).rejects.toThrow(/staged auth DB/i);
		expect(errors.join("\n")).toContain("cannot resolve the upstream vendor");
		expect(errors.join("\n")).toContain("continuing anyway because this is a --dry-run");
	});
});

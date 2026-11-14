/**
 * A tool call that spends a stored credential is a permission-worthy event.
 *
 * THE GAP. The approval tier describes what KIND of tool this is (`read`, `write`, `exec`) and
 * never looks at what the arguments contain. So in `ask`, `auto-edit` and `plan` mode a `bash` call
 * that spends a stored token resolved exactly like one that lists a directory, and the `secrets.*`
 * settings offered `enabled`, `defaultTtl` and `auditLog` and nothing else. Expansion at
 * `transformToolCallArguments` was audited and never gated: `secrets.auditLog` could tell you
 * afterwards which credential the agent had already spent, and nothing could ask you first.
 *
 * WHY IT MIRRORS THE CWD BOUNDARY. The cwd boundary is the existing answer to the same shape of
 * problem, "the tier auto-approved something the tier cannot see": it applies in every non-yolo mode
 * and yolo opts out because yolo opts out of all permission. `secrets.askBeforeUse` turns this one
 * prompt off; the gate suite pins that, and this suite pins what the prompt is about when it is on.
 *
 * THE VALUE MUST NEVER REACH THE REASON. Names are read out of the REDACTED text, so a prompt, a
 * log line, or a headless "requires approval" error cannot carry the credential even if the caller
 * mishandles the string. The suite asserts that directly, in both the named and unnamed cases.
 */
import { describe, expect, it } from "bun:test";
import { secretUse } from "@veyyon/coding-agent/tools/core/secret-use-boundary";

const TOKEN = "ghp_realcredentialvalue1234567890";
const OTHER = "sk-anothercredentialvalue0987654321";

/** A redactor standing in for the session's, replacing exactly the values it was given. */
function redactorFor(values: Record<string, string>): { obfuscateProviderText: (text: string) => string } {
	return {
		obfuscateProviderText: text => {
			let out = text;
			for (const [name, value] of Object.entries(values)) out = out.replaceAll(value, `#${name}#`);
			return out;
		},
	};
}

const context = redactorFor({ GITHUB_TOKEN: TOKEN, OPENAI_KEY: OTHER });

describe("recognising a call that carries a credential", () => {
	/** The central case: the credential is in a shell command the model assembled. */
	it("requires approval and names the secret", () => {
		const reason = secretUse({ command: `curl -H "Authorization: Bearer ${TOKEN}" api` }, context)?.reason;
		expect(reason).toBe(
			"This call uses stored secret: GITHUB_TOKEN. Approving it runs the call with the real credential.",
		);
	});

	/** THE INVARIANT. Whatever else changes about the wording, the value cannot be in it. */
	it("never puts the credential in the reason", () => {
		const reason = secretUse({ command: `echo ${TOKEN}` }, context)?.reason;
		expect(reason).not.toContain(TOKEN);
		expect(reason).toContain("GITHUB_TOKEN");
	});

	/** Two credentials in one call are both named, sorted, so the prompt is stable to read. */
	it("names every secret in the call once, in a stable order", () => {
		const reason = secretUse({ a: `${OTHER} ${TOKEN}`, b: TOKEN }, context)?.reason;
		expect(reason).toBe(
			"This call uses stored secrets: GITHUB_TOKEN, OPENAI_KEY. Approving it runs the call with the real credential.",
		);
	});

	/** A credential nested deep in the arguments counts: serialization walks the whole object. */
	it("finds a credential nested inside the arguments", () => {
		expect(secretUse({ env: { headers: [{ value: TOKEN }] } }, context)?.reason).toContain("GITHUB_TOKEN");
	});

	/**
	 * Inspect raw strings, not their JSON serialization. Quotes, slashes, backslashes, tabs, and
	 * newlines all change representation when serialized; the complete credential must still be
	 * detected both as an object key and as a value before any escaping can split that comparison.
	 */
	it("finds escaped-character credentials in raw JSON keys and values", () => {
		const escaped = 'credential-"slash/and\\backslash-tab\t-newline\n-end';
		const escapedContext = redactorFor({ ESCAPED_TOKEN: escaped });

		expect(secretUse({ [escaped]: "ordinary value" }, escapedContext)?.reason).toContain("ESCAPED_TOKEN");
		expect(secretUse({ payload: escaped }, escapedContext)?.reason).toContain("ESCAPED_TOKEN");
	});

	/**
	 * An unnamed secret is counted, not printed.
	 *
	 * A value placeholder's body is an HMAC token that means nothing to a human, and the count is
	 * the part an operator can act on.
	 */
	it("counts unnamed secrets instead of printing their placeholder body", () => {
		const unnamed = redactorFor({}).obfuscateProviderText;
		const valueForm = {
			obfuscateProviderText: (text: string) => unnamed(text).replaceAll(TOKEN, "#0AB12CD34EF56AB78CD90EF1#"),
		};
		const reason = secretUse({ command: TOKEN }, valueForm)?.reason;
		expect(reason).toBe(
			"This call uses stored secret: one unnamed secret. Approving it runs the call with the real credential.",
		);
		expect(reason).not.toContain("0AB12CD34EF56AB78CD90EF1");
	});

	/**
	 * `mode: replace` rewrites a value one way and leaves no placeholder behind.
	 *
	 * The call still spends a credential, so it still needs approval. Only the name is unavailable,
	 * and the sentence says so rather than claiming zero secrets were involved.
	 */
	it("still requires approval when the redaction leaves no placeholder to name", () => {
		const replacing = { obfuscateProviderText: (text: string) => text.replaceAll(TOKEN, "[redacted]") };
		expect(secretUse({ command: TOKEN }, replacing)?.reason).toBe(
			"This call carries a stored secret value. Approving it runs the call with the real credential.",
		);
	});
});

/**
 * A "for session" answer at a secret prompt is recorded under the secret NAMES, so `named` decides
 * whether one can be offered at all. It must be false whenever any credential the call spends has
 * no name, or a grant for the named ones would let the nameless one through unasked.
 */
describe("which secrets a standing answer can cover", () => {
	const unnamedForm = {
		obfuscateProviderText: (text: string) =>
			context.obfuscateProviderText(text.replaceAll(OTHER, "#0AB12CD34EF56AB78CD90EF1#")),
	};
	it("covers every secret when each one is named", () => {
		expect(secretUse({ a: `${OTHER} ${TOKEN}` }, context)).toMatchObject({
			names: ["GITHUB_TOKEN", "OPENAI_KEY"],
			named: true,
		});
	});

	it("covers nothing when a named secret travels with an unnamed one", () => {
		expect(secretUse({ a: `${OTHER} ${TOKEN}` }, unnamedForm)).toMatchObject({
			names: ["GITHUB_TOKEN"],
			named: false,
		});
	});

	it("covers nothing when the redaction leaves no placeholder", () => {
		const replacing = { obfuscateProviderText: (text: string) => text.replaceAll(TOKEN, "[redacted]") };
		expect(secretUse({ command: TOKEN }, replacing)).toMatchObject({ names: [], named: false });
	});
});

describe("leaving ordinary calls alone", () => {
	/** The common case by far. A call with no credential in it must not prompt. */
	it("returns undefined for arguments that carry no secret", () => {
		expect(secretUse({ command: "ls -la" }, context)?.reason).toBeUndefined();
		expect(secretUse({ path: "/etc/hosts", content: "nothing secret here" }, context)?.reason).toBeUndefined();
	});

	/**
	 * A literal placeholder the model wrote is not a credential.
	 *
	 * When expansion is off the argument still reads `#GITHUB_TOKEN#`, and re-redacting it changes
	 * nothing, so no real value is present and no prompt is owed.
	 */
	it("does not prompt for an unexpanded placeholder", () => {
		expect(secretUse({ command: "curl -H 'Authorization: #GITHUB_TOKEN#'" }, context)?.reason).toBeUndefined();
	});

	/** With no redactor there is nothing configured to protect, so the boundary does not apply. */
	it("returns undefined when no redactor is available", () => {
		expect(secretUse({ command: `echo ${TOKEN}` }, undefined)?.reason).toBeUndefined();
		expect(secretUse({ command: `echo ${TOKEN}` }, {})?.reason).toBeUndefined();
	});

	/** Empty and absent arguments are not credential-bearing and must not prompt. */
	it("returns undefined for empty arguments", () => {
		expect(secretUse({}, context)?.reason).toBeUndefined();
		expect(secretUse(undefined, context)?.reason).toBeUndefined();
	});
});

describe("failing closed on arguments it cannot read", () => {
	/**
	 * Fail closed, matching the cwd boundary's unresolvable-path rule.
	 *
	 * Provider tool calls arrive as JSON so a circular structure is not reachable from a
	 * well-behaved model, but the alternative to prompting is auto-approving a call that could not
	 * be looked at, which is the wrong direction for a control whose whole job is noticing a
	 * credential.
	 */
	it("requires approval when the bounded walk encounters a cycle", () => {
		const circular: Record<string, unknown> = { command: "ls" };
		circular.self = circular;
		expect(secretUse(circular, context)?.reason).toBe(
			"This call's arguments could not be inspected for stored secrets, so it needs explicit approval.",
		);
	});

	/** Accessors are outside the bounded JSON domain and must fail closed without being invoked. */
	it("requires approval when the bounded walk encounters an accessor", () => {
		const hostile = {
			get command(): string {
				throw new Error("must not run");
			},
		};
		expect(secretUse(hostile, context)?.reason).toContain("could not be inspected");
	});

	/** A redactor that throws must not be swallowed into a silent approval. */
	it("does not convert a redactor failure into an approval", () => {
		const broken = {
			obfuscateProviderText: (): string => {
				throw new Error("redactor unavailable");
			},
		};
		expect(() => secretUse({ command: TOKEN }, broken)?.reason).toThrow("redactor unavailable");
	});
});

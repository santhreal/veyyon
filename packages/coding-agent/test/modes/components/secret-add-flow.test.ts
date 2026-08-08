/**
 * The add-a-credential flow inside the Secret Manager card.
 *
 * Every test here defends one of two things: the order the questions are asked in, which is what
 * keeps an operator from storing a label as a credential, and the containment of the value, which
 * is what keeps a live secret off the screen.
 */
import { describe, expect, it } from "bun:test";
import {
	ADD_FLOW_SOURCES,
	type AddFlowSource,
	DEFAULT_ADD_SCOPE,
	EMPTY_ENV_NAME_REFUSAL,
	EMPTY_VALUE_REFUSAL,
	emptyEnvRefusal,
	missingEnvRefusal,
	SecretAddFlow,
	SHORT_VALUE_REFUSAL,
	UNKNOWN_SCOPE_REFUSAL,
} from "@veyyon/coding-agent/modes/components/secret-add-flow";
import { VAULT_SCOPES } from "@veyyon/coding-agent/secrets/vault";

/** A value shaped like a real token, so a leak into rendered text is unmistakable. */
const SECRET = "ghp_ExampleTokenValue_9f3a";

/**
 * The vault's own refusal sentence for a name it will not take.
 *
 * Spelled out here rather than imported so the test proves the operator sees this exact wording,
 * not merely whatever `describeInvalidSecretName` happens to return today.
 */
const invalidNameRefusal = (name: string): string =>
	`"${name}" is not a usable secret name. Use 5 to 64 characters, starting with a letter, ` +
	`containing only A-Z, 0-9 and underscore. The name appears inside #...# in text the model reads, ` +
	`so it has to be unambiguous there.`;

describe("SecretAddFlow question order", () => {
	it("asks for the value first and the name second", () => {
		// The defect this locks out: asking the name first puts a masked field on screen before any
		// credential has been given, and a masked field reads as "type the secret". That is how
		// `/secret add` stored an entry whose VALUE was the literal string `GITHUB_TOKEN`. If this
		// regresses, the manager starts minting credentials out of labels again.
		const flow = new SecretAddFlow();
		expect(flow.step).toBe("value");
		expect(flow.field?.title).toBe("New secret: paste the value");

		flow.submit(SECRET);
		expect(flow.step).toBe("name");
		expect(flow.field?.title).toBe("New secret: name it");
	});

	it("runs value, then name, then scope, then done", () => {
		// Locks the complete order. A step inserted or reordered elsewhere would leave the container
		// showing the scope list before there is anything to scope, or finishing with no plan.
		const flow = new SecretAddFlow();
		const steps = [flow.step];
		for (const answer of [SECRET, "deploy key", "project"]) {
			flow.submit(answer);
			steps.push(flow.step);
		}
		expect(steps).toEqual(["value", "name", "scope", "done"]);
	});

	it("does not advance past done when another answer arrives", () => {
		// A stray keystroke after the last step must not rewrite a finished plan. Without the guard,
		// the trailing input would fall through a step handler and corrupt what is about to be stored.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("project");
		flow.submit("global");
		expect(flow.step).toBe("done");
		expect(flow.plan).toEqual({ name: "DEPLOY_KEY", value: SECRET, scope: "project" });
	});
});

describe("SecretAddFlow field masking", () => {
	it("masks the value field", () => {
		// If masking is lost on the value step, the credential is painted into the terminal
		// scrollback the moment it is typed, where the operator cannot get it back out.
		const flow = new SecretAddFlow();
		expect(flow.field?.masked).toBe(true);
	});

	it("does not mask the name field", () => {
		// The inverse defect: a masked name field is the illusion that made an operator answer it
		// with a credential. The name must be readable so a typo in a label is visible.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		expect(flow.field?.masked).toBe(false);
		expect(flow.field?.hint).toBe(
			"Letters, digits, spaces, dashes and underscores. Leave it blank to have a name generated for you.",
		);
	});

	it("does not mask the scope field", () => {
		// A masked choice list would hide which scope is being picked, which is the one thing that
		// step exists to show.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		expect(flow.field).toEqual({
			step: "scope",
			title: "New secret: choose a scope",
			hint: "Who can see it: global, profile, project. Leave it blank to keep profile.",
			masked: false,
		});
	});

	it("has no field left to draw once the flow is done", () => {
		// The container draws whatever `field` returns. A stale field at `done` would leave the last
		// question on screen beside a finished plan, so the operator could answer it twice.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("project");
		expect(flow.field).toBeUndefined();
	});
});

describe("SecretAddFlow value field", () => {
	it("refuses an empty value with a sentence and stays on the step", () => {
		// An empty credential expands to nothing and authenticates nothing, so storing one produces a
		// vault entry that silently fails wherever it is used. Refuse at the field, where it can be
		// fixed, rather than accepting it into the vault.
		const flow = new SecretAddFlow();
		flow.submit("");
		expect(flow.step).toBe("value");
		expect(flow.refusal).toBe(
			"Enter the credential itself. An empty secret would store nothing and expand to nothing, so it is never what you meant.",
		);
		expect(flow.plan).toBeUndefined();
	});

	it("refuses a value that is only whitespace", () => {
		// Whitespace passes a naive length check and is never a credential. Without the trim, a
		// stray space bar would advance the flow and store a blank secret.
		const flow = new SecretAddFlow();
		flow.submit("   \t  ");
		expect(flow.step).toBe("value");
		expect(flow.refusal).toBe(EMPTY_VALUE_REFUSAL);
	});

	it("clears the refusal once a real value is given", () => {
		// A refusal that outlives its cause leaves the operator reading an error about a field they
		// have already fixed, on the next question.
		const flow = new SecretAddFlow();
		flow.submit("");
		expect(flow.refusal).toBe(EMPTY_VALUE_REFUSAL);
		flow.submit(SECRET);
		expect(flow.refusal).toBeNull();
	});

	it("keeps the value exactly as typed, including surrounding whitespace", () => {
		// Trimming a credential produces a stored value that does not authenticate, and the failure
		// surfaces far away from here with nothing pointing back at the trim.
		const flow = new SecretAddFlow();
		flow.submit(`  ${SECRET}\n`);
		flow.submit("");
		flow.submit("");
		expect(flow.plan?.value).toBe(`  ${SECRET}\n`);
	});

	it("refuses a value the vault is going to refuse, at the field that still holds it", () => {
		// REGRESSION: the flow enforced only emptiness, so a seven-character credential was accepted
		// here, carried through the name question and the scope question, and refused by `vault.add`
		// at the very end with "This secret is 7 characters, under the 8-character minimum". The
		// container discards the flow on that failure, so the operator was returned to the roster
		// having lost the credential, the name and the scope, and had to retype all three to be
		// told the same thing. The name step has always run the vault's own normaliser for exactly
		// this reason; the value step did not. If this regresses, a short paste costs three fields
		// again and nothing on the value field says why.
		const flow = new SecretAddFlow();
		flow.submit("pin1234");
		expect(flow.step).toBe("value");
		expect(flow.refusal).toBe(SHORT_VALUE_REFUSAL);
		expect(flow.refusal).toBe(
			"A credential has to be at least 8 characters. Anything shorter cannot be swapped for a " +
				"placeholder without cutting into ordinary words, so the vault will not store it.",
		);
		// One more character is the whole difference, and it must be enough.
		flow.submit("pin12345");
		expect(flow.step).toBe("name");
		expect(flow.refusal).toBeNull();
	});

	it("measures the untrimmed value, because that is the string the vault measures", () => {
		// The emptiness test trims and this one must not. `vault.add` counts code points in the
		// value as stored, and the flow stores what was typed, so a value that is only long enough
		// with its whitespace has to be accepted here or the two rules disagree by exactly the
		// characters the flow promised to keep.
		const flow = new SecretAddFlow();
		flow.submit("  ab  ");
		expect(flow.step).toBe("value");
		expect(flow.refusal).toBe(SHORT_VALUE_REFUSAL);

		const padded = new SecretAddFlow();
		padded.submit("  abcd  ");
		expect(padded.step).toBe("name");
		expect(padded.refusal).toBeNull();
	});

	it("refuses an empty value as empty rather than as too short", () => {
		// Two rules, two sentences, and the order matters. Pressing enter on an untouched field is a
		// different mistake from pasting something short, and the length rule would swallow it: an
		// operator told "at least 8 characters" about a field they typed nothing into is being
		// answered a question they did not ask.
		const flow = new SecretAddFlow();
		flow.submit("");
		expect(flow.refusal).toBe(EMPTY_VALUE_REFUSAL);
		const blank = new SecretAddFlow();
		blank.submit("        ");
		expect(blank.refusal).toBe(EMPTY_VALUE_REFUSAL);
	});
});

describe("SecretAddFlow name field", () => {
	it("accepts a blank name and reports it as undefined in the plan", () => {
		// Blank means "generate one for me". Passing an empty string through to `vault.add` instead
		// of `undefined` would ask the vault to store a nameless entry rather than invent a name.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("   ");
		expect(flow.step).toBe("scope");
		expect(flow.refusal).toBeNull();
		flow.submit("");
		expect(flow.plan?.name).toBeUndefined();
	});

	it("normalises a typed name the way the vault does", () => {
		// The flow must hand over the name the vault would produce. If it stored the raw text, the
		// entry would land under a name the operator never saw in the confirmation.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("  github token  ");
		flow.submit("");
		expect(flow.plan?.name).toBe("GITHUB_TOKEN");
	});

	it("refuses a name the vault would reject, at the field, with the vault's reason", () => {
		// Accepting it here and letting `vault.add` throw later reports the failure after the card
		// has closed the prompt, so the operator loses the value they just typed.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("gh!");
		expect(flow.step).toBe("name");
		expect(flow.refusal).toBe(invalidNameRefusal("gh!"));
		expect(flow.plan).toBeUndefined();
	});

	it("refuses a name one character below the minimum and accepts one at it", () => {
		// The boundary the vault enforces is five characters. An off-by-one here would let a
		// four-character name through the field and be rejected at store time.
		const short = new SecretAddFlow();
		short.submit(SECRET);
		short.submit("abcd");
		expect(short.step).toBe("name");
		expect(short.refusal).toBe(invalidNameRefusal("abcd"));

		const exact = new SecretAddFlow();
		exact.submit(SECRET);
		exact.submit("abcde");
		exact.submit("");
		expect(exact.plan?.name).toBe("ABCDE");
	});

	it("refuses a name one character above the maximum and accepts one at it", () => {
		// The other boundary, sixty-four characters. A name longer than that cannot be written as a
		// `#NAME#` placeholder the model can read back.
		const overLong = "A".repeat(65);
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit(overLong);
		expect(flow.step).toBe("name");
		expect(flow.refusal).toBe(invalidNameRefusal(overLong));

		const exact = new SecretAddFlow();
		exact.submit(SECRET);
		exact.submit("B".repeat(64));
		exact.submit("");
		expect(exact.plan?.name).toBe("B".repeat(64));
	});

	it("refuses an absurdly long name input without echoing all of it", () => {
		// Adversarial input: a pasted wall of text. The vault has a separate, shorter sentence for
		// this so a refusal never repeats a hundred and thirty characters back at the operator.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("A".repeat(129));
		expect(flow.step).toBe("name");
		expect(flow.refusal).toBe("This secret name input is too long. Use 64 characters or fewer after trimming.");
	});
});

describe("SecretAddFlow scope step", () => {
	it("offers the three real scopes in the vault's order", () => {
		// The list is the vault's, widest first. A hand-written list here would drift the moment a
		// scope is added or renamed, and offer a scope that cannot be written to.
		const flow = new SecretAddFlow();
		expect(flow.scopeChoices).toEqual(["global", "profile", "project"]);
	});

	it("defaults to profile when the scope is left blank", () => {
		// Blank must resolve to a real scope. Defaulting to nothing would hand `vault.add` an
		// undefined scope and store the credential wherever the vault happens to fall back to.
		const flow = new SecretAddFlow();
		expect(flow.scope).toBe(DEFAULT_ADD_SCOPE);
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("");
		expect(flow.plan?.scope).toBe("profile");
	});

	it("accepts a scope in any case and with surrounding whitespace", () => {
		// The operator types the scope. Refusing `Project ` for its shape would be a refusal about
		// typing, not about scopes.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("  GLOBAL ");
		expect(flow.scope).toBe("global");
		expect(flow.plan?.scope).toBe("global");
	});

	it("refuses a scope the vault does not have and stays on the step", () => {
		// A typo such as `prfile` must not fall through to the default, because that would store the
		// credential somewhere other than where the operator asked, and say nothing about it.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("prfile");
		expect(flow.step).toBe("scope");
		expect(flow.refusal).toBe("That is not a scope a vault has. Choose global, profile, project.");
		expect(flow.scope).toBe("profile");
		expect(flow.plan).toBeUndefined();
	});

	it("names every real scope in the refusal, and no scope the vault does not have", () => {
		// The spelled-out sentence above pins the wording an operator reads today. This pins the
		// thing that wording is DERIVED from, which the literal cannot: add a fourth scope to
		// `VAULT_SCOPES` and the refusal must start offering it. Otherwise the card refuses a
		// perfectly real scope while listing three of the four places it could have gone, and the
		// only clue is a sentence that still looks correct.
		for (const scope of VAULT_SCOPES) expect(UNKNOWN_SCOPE_REFUSAL).toContain(scope);
		expect(UNKNOWN_SCOPE_REFUSAL).not.toContain("session");

		// And the refusal the flow actually emits is that same constant, not a parallel sentence
		// that happens to match it right now.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("nowhere");
		expect(flow.refusal).toBe(UNKNOWN_SCOPE_REFUSAL);
	});
});

describe("SecretAddFlow back()", () => {
	it("changes nothing at the first step", () => {
		// There is nothing behind the value question. The container reads a back here as cancel, so
		// the flow must not step into a state that has no field to draw.
		const flow = new SecretAddFlow();
		flow.back();
		expect(flow.step).toBe("value");
		expect(flow.field?.step).toBe("value");
	});

	it("returns from the name step to the value step, and a new value replaces the old one", () => {
		// Back has to be real, not cosmetic. If it only moved the step marker without letting the
		// next submission overwrite the value, the operator would correct a mistyped credential and
		// store the original anyway.
		const flow = new SecretAddFlow();
		flow.submit("wrong-token");
		flow.back();
		expect(flow.step).toBe("value");
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("");
		expect(flow.plan?.value).toBe(SECRET);
	});

	it("returns from the scope step to the name step", () => {
		// The step before scope is the name, not the value. Skipping back two steps would force the
		// operator to retype a credential they only wanted to relabel.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.back();
		expect(flow.step).toBe("name");
		expect(flow.field?.masked).toBe(false);
	});

	it("returns from done to the scope step and withdraws the plan", () => {
		// A plan still readable after stepping back is a plan the container could store while the
		// operator is in the middle of amending it.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("project");
		flow.back();
		expect(flow.step).toBe("scope");
		expect(flow.plan).toBeUndefined();
		flow.submit("global");
		expect(flow.plan).toEqual({ name: "DEPLOY_KEY", value: SECRET, scope: "global" });
	});

	it("clears a refusal on the way back", () => {
		// Carrying the refusal backwards shows an error about the field the operator just left,
		// attached to the field they returned to.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("gh!");
		expect(flow.refusal).toBe(invalidNameRefusal("gh!"));
		flow.back();
		expect(flow.step).toBe("value");
		expect(flow.refusal).toBeNull();
	});
});

describe("SecretAddFlow value containment", () => {
	it("exposes the value through plan and through nothing else", () => {
		// The one rule the whole module exists under: a credential must never reach a rendered
		// string. Every accessor is sampled at every step, including while a refusal is showing,
		// because a refusal is the tempting place to echo what was typed. If a new accessor is added
		// it must be sampled here too, which is what the exact sample count below enforces.
		const flow = new SecretAddFlow();
		const seen: string[] = [];
		const capture = (): void => {
			seen.push(flow.step, flow.scope, ...flow.scopeChoices);
			if (flow.refusal !== null) seen.push(flow.refusal);
			const field = flow.field;
			if (field !== undefined) seen.push(field.step, field.title, field.hint);
		};

		capture();
		flow.submit("");
		capture();
		flow.submit(SECRET);
		capture();
		flow.submit("deploy key");
		capture();
		flow.submit("project");
		capture();

		expect(seen).toHaveLength(38);
		for (const text of seen) {
			expect(text).not.toContain(SECRET);
			// Also catch a truncated or partially rendered credential, which `toContain` on the whole
			// value would miss.
			expect(text).not.toContain("ghp_");
		}
		expect(flow.plan?.value).toBe(SECRET);
	});

	it("produces the exact plan the container hands to vault.add", () => {
		// The plan is the module's entire output. An extra field, a raw name, or a stringified scope
		// would be discovered by the vault rather than here.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("deploy key");
		flow.submit("project");
		expect(flow.plan).toEqual({ name: "DEPLOY_KEY", value: SECRET, scope: "project" });
	});
});

/**
 * Reading the credential out of the environment, which is the `f` key on the card.
 *
 * WHY THIS PATH EXISTS AT ALL: it is the only entry form where the credential never reaches the
 * screen, the input buffer, or the shell history. `/secret --from-env VAR` has always offered it on
 * the command line; the manager could not, so the safest way in was the one the GUI lacked.
 *
 * WHAT THIS SUITE CLOSES: every way naming a variable can fail to produce a storable credential is
 * refused AT THE FIELD, and the refusal names the variable. The class it is guarding against is a
 * refusal that arrives from `vault.add` two questions later, after the container has torn the flow
 * down: that is what made the pasted path lose the credential, the name and the scope on a value
 * the obfuscator could not protect, and the environment path can fail four ways rather than two.
 *
 * WHAT IT DOES NOT CATCH: whether the real `process.env` is the environment the operator meant.
 * `readEnv` is injected here, deliberately, because a test that wrote `process.env` would leak that
 * variable into every file that ran after it. The default wiring to `process.env` is asserted below
 * by the ONE case that reads a variable this process really has.
 */
describe("SecretAddFlow reading a credential out of the environment", () => {
	const ENV_VALUE = "ghp_FromTheEnvironment_71c4";
	const env = (variables: Record<string, string>) => (variable: string) => variables[variable];

	it("asks for the variable's name, unmasked, and says so", () => {
		// UNMASKED IS THE POINT, and it is the one field here that must not be hidden. A variable name
		// is not a credential; masking it would make a typo in `GITHUB_TOEKN` indistinguishable from
		// the variable being unset, which are the two failures this step exists to tell apart.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({}) });
		expect(flow.step).toBe("env");
		expect(flow.field).toEqual({
			step: "env",
			title: "New secret: name the environment variable",
			hint: "The variable's NAME, not its value: veyyon reads the credential out of its own environment, so nothing secret is typed or drawn. This field is not masked, because a variable name is not a credential.",
			masked: false,
		});
	});

	it("reads the variable and carries it into the plan", () => {
		// The plan says WHERE the value came from, which is what lets the card's confirmation name the
		// variable. Without it an operator who read the wrong variable has stored the wrong credential
		// and the only screen that could have said so said "Stored #NAME#" like any other add.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ GITHUB_TOKEN: ENV_VALUE }) });
		flow.submit("GITHUB_TOKEN");
		expect(flow.step).toBe("name");
		flow.submit("deploy key");
		flow.submit("project");
		expect(flow.plan).toEqual({ name: "DEPLOY_KEY", value: ENV_VALUE, scope: "project", fromEnv: "GITHUB_TOKEN" });
	});

	it("keeps the variable's bytes verbatim", () => {
		// A credential exported by another tool legitimately carries a trailing newline, and a trimmed
		// copy authenticates against nothing. The pasted path keeps bytes for the same reason.
		const raw = `${ENV_VALUE}\n`;
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ TOKEN: raw }) });
		flow.submit("TOKEN");
		flow.submit("");
		flow.submit("");
		expect(flow.plan?.value).toBe(raw);
	});

	it("trims the variable NAME, because a stray space is not part of it", () => {
		// The name is typed, so it collects the spaces typing collects. `env["TOKEN "]` is not `TOKEN`,
		// and refusing a variable the operator can see in their shell would be indistinguishable from
		// the variable being unset.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ TOKEN: ENV_VALUE }) });
		flow.submit("  TOKEN  ");
		expect(flow.refusal).toBeNull();
		expect(flow.step).toBe("name");
	});

	/**
	 * THE FOUR WAYS THIS STEP CAN FAIL, each refused here rather than at the write.
	 *
	 * Named as a table so a fifth failure mode added to `#submitEnv` without a row is visible as a
	 * gap in one place, rather than as four tests that happen to exist and a fifth that does not.
	 */
	const REFUSALS: readonly {
		readonly why: string;
		readonly variables: Record<string, string>;
		readonly typed: string;
		readonly refusal: string;
	}[] = [
		{ why: "nothing was typed", variables: {}, typed: "   ", refusal: EMPTY_ENV_NAME_REFUSAL },
		{
			why: "the variable is unset",
			variables: {},
			typed: "GITHUB_TOEKN",
			refusal: missingEnvRefusal("GITHUB_TOEKN"),
		},
		{ why: "the variable is empty", variables: { TOKEN: "   " }, typed: "TOKEN", refusal: emptyEnvRefusal("TOKEN") },
		{
			why: "the value is too short to protect",
			variables: { TOKEN: "ab" },
			typed: "TOKEN",
			refusal: SHORT_VALUE_REFUSAL,
		},
	];

	for (const { why, variables, typed, refusal } of REFUSALS) {
		it(`refuses, stays on the step, and stores nothing when ${why}`, () => {
			const flow = new SecretAddFlow({ source: "env", readEnv: env(variables) });
			flow.submit(typed);
			expect(flow.refusal).toBe(refusal);
			expect(flow.step).toBe("env");
			expect(flow.plan).toBeUndefined();
		});
	}

	it("names the variable in the refusals that are about a variable", () => {
		// The one refusal in this module that echoes what was typed. Hiding it leaves "something is not
		// set" on screen, which an operator cannot act on: the whole diagnosis is which name was read.
		expect(missingEnvRefusal("GITHUB_TOEKN")).toContain("GITHUB_TOEKN");
		expect(emptyEnvRefusal("GITHUB_TOEKN")).toContain("GITHUB_TOEKN");
		// And they are DIFFERENT sentences: "unset" and "set but empty" are different mistakes with
		// different fixes, and one sentence for both sends half of the operators to the wrong shell.
		expect(missingEnvRefusal("TOKEN")).not.toBe(emptyEnvRefusal("TOKEN"));
	});

	it("recovers from a refusal without restarting the flow", () => {
		// A refusal that cost the operator the flow is the defect the value step was already fixed for.
		// The corrected variable is read on the spot.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ GITHUB_TOKEN: ENV_VALUE }) });
		flow.submit("GITHUB_TOEKN");
		flow.submit("GITHUB_TOKEN");
		expect(flow.refusal).toBeNull();
		flow.submit("");
		flow.submit("");
		expect(flow.plan?.value).toBe(ENV_VALUE);
	});

	it("never lets the value it read reach a rendered string", () => {
		// The same containment rule the pasted path is held to, asserted on the path where the operator
		// never saw the value: a leak here is worse, because nothing on screen would look wrong.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ TOKEN: ENV_VALUE }) });
		const seen: string[] = [];
		const capture = (): void => {
			seen.push(flow.step, flow.scope, ...flow.scopeChoices);
			if (flow.refusal !== null) seen.push(flow.refusal);
			const field = flow.field;
			if (field !== undefined) seen.push(field.step, field.title, field.hint);
		};
		capture();
		flow.submit("TOKEN");
		capture();
		flow.submit("deploy key");
		capture();
		flow.submit("project");
		capture();
		expect(seen.length).toBeGreaterThan(0);
		for (const text of seen) {
			expect(text).not.toContain(ENV_VALUE);
			expect(text).not.toContain("ghp_");
		}
		expect(flow.plan?.value).toBe(ENV_VALUE);
	});

	it("reads the real process environment when nothing is injected", () => {
		// The default wiring, proven against a variable every process has rather than one this test
		// exports: writing `process.env` here would leak into every file that runs afterwards.
		process.env.PATH ??= "/usr/bin";
		const flow = new SecretAddFlow({ source: "env" });
		flow.submit("PATH");
		expect(flow.refusal).toBeNull();
		flow.submit("");
		flow.submit("");
		expect(flow.plan?.value).toBe(process.env.PATH);
		expect(flow.plan?.fromEnv).toBe("PATH");
	});
});

/**
 * What every source has in common, driven over ADD_FLOW_SOURCES rather than over the two anybody
 * remembered.
 *
 * WHY IT IS DERIVED: a third source added to the flow reaches these same name and scope steps, and
 * the failure mode is that it reaches them slightly differently. Deriving the rows from the exported
 * list means such a source has no test row, so `FIRST_ANSWER` returns `undefined` and the suite goes
 * red until somebody records what it answers. A hardcoded pair of sources would stay green.
 */
describe("every add source reaches the same questions", () => {
	const ENV_VALUE = "ghp_SourceParityValue_44de";
	/** How each source answers its own first question, and what a submitted first answer stores. */
	const FIRST_ANSWER: Partial<Record<AddFlowSource, { readonly answer: string; readonly stored: string }>> = {
		paste: { answer: ENV_VALUE, stored: ENV_VALUE },
		env: { answer: "TOKEN", stored: ENV_VALUE },
	};
	const flowFor = (source: AddFlowSource): SecretAddFlow =>
		new SecretAddFlow({ source, readEnv: variable => (variable === "TOKEN" ? ENV_VALUE : undefined) });

	for (const source of ADD_FLOW_SOURCES) {
		const first = FIRST_ANSWER[source];
		it(`asks ${source} for its own first answer, then the name, then the scope`, () => {
			// A source with no row here is a source nobody has said anything about. That is the failure
			// this expectation is for: it fires the moment ADD_FLOW_SOURCES grows.
			expect(first).toBeDefined();
			if (first === undefined) return;
			const flow = flowFor(source);
			const steps = [flow.step];
			for (const answer of [first.answer, "deploy key", "project"]) {
				flow.submit(answer);
				steps.push(flow.step);
			}
			expect(steps.slice(1)).toEqual(["name", "scope", "done"]);
			expect(flow.plan?.value).toBe(first.stored);
			expect(flow.plan?.name).toBe("DEPLOY_KEY");
			expect(flow.plan?.scope).toBe("project");
		});

		it(`treats a back at ${source}'s first question as nothing`, () => {
			// The container reads a back at the first step as cancel. A source that stepped somewhere
			// else would leave the card showing a field with no question behind it.
			const flow = flowFor(source);
			const opened = flow.step;
			flow.back();
			expect(flow.step).toBe(opened);
			expect(flow.field?.step).toBe(opened);
		});

		it(`returns from the name step to ${source}'s own first question`, () => {
			// THE DEFECT THIS CLOSES: back was hardcoded to the masked value field, so an operator who
			// mistyped a variable name and pressed escape was handed a masked field asking for a
			// credential they had deliberately chosen never to type.
			expect(first).toBeDefined();
			if (first === undefined) return;
			const flow = flowFor(source);
			const opened = flow.step;
			flow.submit(first.answer);
			flow.back();
			expect(flow.step).toBe(opened);
			expect(flow.field?.step).toBe(opened);
		});

		it(`defaults ${source} to the ${DEFAULT_ADD_SCOPE} scope`, () => {
			expect(first).toBeDefined();
			if (first === undefined) return;
			const flow = flowFor(source);
			expect(flow.scope).toBe(DEFAULT_ADD_SCOPE);
			expect(flow.scopeChoices).toEqual(VAULT_SCOPES);
			flow.submit(first.answer);
			flow.submit("");
			flow.submit("");
			expect(flow.plan?.scope).toBe(DEFAULT_ADD_SCOPE);
		});
	}
});

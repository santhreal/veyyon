/**
 * The add-a-credential flow inside the Secret Manager card.
 *
 * WHAT THIS SUITE DEFENDS. Two things, and they are the whole module. First, ONE QUESTION: the
 * credential is stored the moment its value is known, so storing a token costs one field and not
 * three. Second, CONTAINMENT: the value leaves through `plan` and reaches no other accessor, so a
 * live credential cannot be painted onto the screen.
 *
 * WHY ONE QUESTION IS A CONTRACT AND NOT A PREFERENCE. The flow used to ask for a name and a scope
 * as well. Both describe an entry that has to exist before either means anything, both are one
 * keystroke away on the row that appears (`n` renames, `m` moves), and the middle field was a masked
 * prompt asking for a name, which is how `/secret add` came to hold an entry whose value was the
 * literal string `GITHUB_TOKEN`. With the question gone that mistake is not expressible, and the
 * question-count assertions below are what keep it gone: they are derived over ADD_FLOW_SOURCES and
 * count fields rather than naming the two steps that were removed, so re-adding a step anywhere in
 * the flow turns them red rather than only re-adding the two that used to be there.
 *
 * WHAT IT DOES NOT CATCH. Whether the vault's generated name is a good name, and whether `n` and `m`
 * do what the confirmation says: both live on the container, and are covered by
 * `secret-manager-credential-management.test.ts` against a real vault.
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
} from "@veyyon/coding-agent/modes/components/secret-add-flow";
import { VAULT_SCOPES } from "@veyyon/coding-agent/secrets/vault";

/** A value shaped like a real token, so a leak into rendered text is unmistakable. */
const SECRET = "ghp_ExampleTokenValue_9f3a";

/**
 * Answer whatever is being asked until the flow is done, and report how many fields it drew.
 *
 * The count is the contract. A flow that asks for a name again, or for a scope, or for anything
 * else, draws two fields for one credential and this returns 2.
 */
function drive(flow: SecretAddFlow, answers: readonly string[]): number {
	let drawn = 0;
	for (const answer of answers) {
		if (flow.field === undefined) break;
		drawn += 1;
		flow.submit(answer);
	}
	return drawn;
}

describe("SecretAddFlow asks one question", () => {
	it("stores as soon as the value is given", () => {
		// The defect this locks out is the three-prompt store: value, then name, then scope, for one
		// credential. If a step comes back, `step` is not `done` here and the plan is undefined.
		const flow = new SecretAddFlow();
		expect(flow.step).toBe("value");
		expect(flow.field?.title).toBe("New secret: paste the value");

		flow.submit(SECRET);
		expect(flow.step).toBe("done");
		expect(flow.field).toBeUndefined();
		expect(flow.plan).toEqual({ value: SECRET });
	});

	it("draws exactly one field for one credential", () => {
		// Counted rather than named, so a step inserted anywhere fails this: the old suite pinned the
		// sequence `value, name, scope, done`, which a NEW third question would have satisfied.
		const flow = new SecretAddFlow();
		expect(drive(flow, [SECRET, "deploy key", "project", "global"])).toBe(1);
		expect(flow.step).toBe("done");
	});

	it("does not advance past done when another answer arrives", () => {
		// A stray keystroke after the answer must not rewrite a finished plan. Without the guard the
		// trailing input would fall through a step handler and corrupt what is about to be stored.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.submit("something else entirely");
		expect(flow.step).toBe("done");
		expect(flow.plan).toEqual({ value: SECRET });
	});

	it("hands over the value and the source, and nothing else", () => {
		// `toEqual` on the whole plan, so a name or a scope reappearing as a plan field is a failure
		// here rather than a surprise inside `vault.add`.
		const pasted = new SecretAddFlow();
		pasted.submit(SECRET);
		expect(Object.keys(pasted.plan ?? {}).sort()).toEqual(["value"]);

		const read = new SecretAddFlow({ source: "env", readEnv: () => SECRET });
		read.submit("TOKEN");
		expect(Object.keys(read.plan ?? {}).sort()).toEqual(["fromEnv", "value"]);
	});

	it("names a scope the vault really has as the one it stores into", () => {
		// The container stores at DEFAULT_ADD_SCOPE without asking. Derived from the vault's own list
		// so renaming a scope cannot leave this constant pointing at a scope that cannot be written.
		expect(VAULT_SCOPES).toContain(DEFAULT_ADD_SCOPE);
	});
});

describe("SecretAddFlow field masking", () => {
	it("masks the value field", () => {
		// If masking is lost on the value step, the credential is painted into the terminal
		// scrollback the moment it is typed, where the operator cannot get it back out.
		const flow = new SecretAddFlow();
		expect(flow.field?.masked).toBe(true);
	});

	it("does not mask the environment variable's name", () => {
		// The inverse defect: a masked field asking for anything other than the value is the illusion
		// that made an operator answer it with a credential. A variable name has to be readable, or a
		// typo in `GITHUB_TOEKN` is indistinguishable from the variable being unset.
		const flow = new SecretAddFlow({ source: "env", readEnv: () => undefined });
		expect(flow.field?.masked).toBe(false);
	});

	it("has no field left to draw once the flow is done", () => {
		// The container draws whatever `field` returns. A stale field at `done` would leave the
		// question on screen beside a finished plan, so the operator could answer it twice.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
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
		// stray space bar would finish the flow and store a blank secret.
		const flow = new SecretAddFlow();
		flow.submit("   \t  ");
		expect(flow.step).toBe("value");
		expect(flow.refusal).toBe(EMPTY_VALUE_REFUSAL);
	});

	it("clears the refusal once a real value is given", () => {
		// A refusal that outlives its cause leaves the operator reading an error about a field they
		// have already fixed, over a credential that is already stored.
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
		expect(flow.plan?.value).toBe(`  ${SECRET}\n`);
	});

	it("refuses a value the vault is going to refuse, at the field that still holds it", () => {
		// REGRESSION: the flow enforced only emptiness, so a seven-character credential was accepted
		// here and refused by `vault.add` at the write. The container discards the flow on that
		// failure, so the operator was returned to the roster having lost the credential and had to
		// retype it to be told the same thing. If this regresses, a short paste costs the whole flow
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
		expect(flow.step).toBe("done");
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
		expect(padded.step).toBe("done");
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

describe("SecretAddFlow back()", () => {
	it("changes nothing at the question", () => {
		// There is nothing behind the only question. The container reads a back here as cancel, so the
		// flow must not step into a state that has no field to draw.
		const flow = new SecretAddFlow();
		flow.back();
		expect(flow.step).toBe("value");
		expect(flow.field?.step).toBe("value");
		expect(flow.plan).toBeUndefined();
	});

	it("clears a refusal", () => {
		// Carrying a refusal past a cancel shows an error about a field the operator has left, over
		// the next thing they open.
		const flow = new SecretAddFlow();
		flow.submit("pin1234");
		expect(flow.refusal).toBe(SHORT_VALUE_REFUSAL);
		flow.back();
		expect(flow.refusal).toBeNull();
	});

	it("cannot withdraw a credential that has already been answered", () => {
		// The value is stored the moment it is given, so there is no state behind `done` to return to.
		// A back that reopened a question here would let the container store twice.
		const flow = new SecretAddFlow();
		flow.submit(SECRET);
		flow.back();
		expect(flow.step).toBe("done");
		expect(flow.plan).toEqual({ value: SECRET });
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
			seen.push(flow.step);
			if (flow.refusal !== null) seen.push(flow.refusal);
			const field = flow.field;
			if (field !== undefined) seen.push(field.step, field.title, field.hint);
		};

		capture();
		flow.submit("");
		capture();
		flow.submit(SECRET);
		capture();

		expect(seen).toHaveLength(10);
		for (const text of seen) {
			expect(text).not.toContain(SECRET);
			// Also catch a truncated or partially rendered credential, which `toContain` on the whole
			// value would miss.
			expect(text).not.toContain("ghp_");
		}
		expect(flow.plan?.value).toBe(SECRET);
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
 * refusal that arrives from `vault.add` after the container has torn the flow down, which is what
 * made the pasted path lose a credential the obfuscator could not protect. The environment path can
 * fail four ways rather than two.
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

	it("reads the variable, stores at once, and carries the source into the plan", () => {
		// The plan says WHERE the value came from, which is what lets the card's confirmation name the
		// variable. Without it an operator who read the wrong variable has stored the wrong credential
		// and the only screen that could have said so said "Stored #NAME#" like any other add.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ GITHUB_TOKEN: ENV_VALUE }) });
		flow.submit("GITHUB_TOKEN");
		expect(flow.step).toBe("done");
		expect(flow.plan).toEqual({ value: ENV_VALUE, fromEnv: "GITHUB_TOKEN" });
	});

	it("keeps the variable's bytes verbatim", () => {
		// A credential exported by another tool legitimately carries a trailing newline, and a trimmed
		// copy authenticates against nothing. The pasted path keeps bytes for the same reason.
		const raw = `${ENV_VALUE}\n`;
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ TOKEN: raw }) });
		flow.submit("TOKEN");
		expect(flow.plan?.value).toBe(raw);
	});

	it("trims the variable NAME, because a stray space is not part of it", () => {
		// The name is typed, so it collects the spaces typing collects. `env["TOKEN "]` is not `TOKEN`,
		// and refusing a variable the operator can see in their shell would be indistinguishable from
		// the variable being unset.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ TOKEN: ENV_VALUE }) });
		flow.submit("  TOKEN  ");
		expect(flow.refusal).toBeNull();
		expect(flow.step).toBe("done");
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
		expect(flow.plan?.value).toBe(ENV_VALUE);
	});

	it("never lets the value it read reach a rendered string", () => {
		// The same containment rule the pasted path is held to, asserted on the path where the operator
		// never saw the value: a leak here is worse, because nothing on screen would look wrong.
		const flow = new SecretAddFlow({ source: "env", readEnv: env({ TOKEN: ENV_VALUE }) });
		const seen: string[] = [];
		const capture = (): void => {
			seen.push(flow.step);
			if (flow.refusal !== null) seen.push(flow.refusal);
			const field = flow.field;
			if (field !== undefined) seen.push(field.step, field.title, field.hint);
		};
		capture();
		flow.submit("NOPE");
		capture();
		flow.submit("TOKEN");
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
		expect(flow.plan?.value).toBe(process.env.PATH);
		expect(flow.plan?.fromEnv).toBe("PATH");
	});
});

/**
 * What every source has in common, driven over ADD_FLOW_SOURCES rather than over the two anybody
 * remembered.
 *
 * WHY IT IS DERIVED: a third source added to the flow has to store on its first answer like the
 * other two, and the failure mode is that it asks something extra. Deriving the rows from the
 * exported list means such a source has no test row, so `FIRST_ANSWER` returns `undefined` and the
 * suite goes red until somebody records what it answers. A hardcoded pair of sources would stay
 * green.
 */
describe("every add source stores on its own first answer", () => {
	const ENV_VALUE = "ghp_SourceParityValue_44de";
	/** How each source answers its own question, and what a submitted answer stores. */
	const FIRST_ANSWER: Partial<Record<AddFlowSource, { readonly answer: string; readonly stored: string }>> = {
		paste: { answer: ENV_VALUE, stored: ENV_VALUE },
		env: { answer: "TOKEN", stored: ENV_VALUE },
	};
	const flowFor = (source: AddFlowSource): SecretAddFlow =>
		new SecretAddFlow({ source, readEnv: variable => (variable === "TOKEN" ? ENV_VALUE : undefined) });

	for (const source of ADD_FLOW_SOURCES) {
		const first = FIRST_ANSWER[source];
		it(`asks ${source} exactly one question`, () => {
			// A source with no row here is a source nobody has said anything about. That is the failure
			// this expectation is for: it fires the moment ADD_FLOW_SOURCES grows. The count is what
			// keeps a name or a scope question from coming back on one source and not the other.
			expect(first).toBeDefined();
			if (first === undefined) return;
			const flow = flowFor(source);
			expect(drive(flow, [first.answer, "deploy key", "project"])).toBe(1);
			expect(flow.step).toBe("done");
			expect(flow.plan?.value).toBe(first.stored);
		});

		it(`treats a back at ${source}'s question as nothing`, () => {
			// The container reads a back at the question as cancel. A source that stepped somewhere
			// else would leave the card showing a field with no question behind it.
			const flow = flowFor(source);
			const opened = flow.step;
			flow.back();
			expect(flow.step).toBe(opened);
			expect(flow.field?.step).toBe(opened);
		});
	}
});

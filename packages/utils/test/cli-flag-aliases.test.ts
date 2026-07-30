import { describe, expect, it } from "bun:test";
import { type CliConfig, CliUsageError, Command, Flags, renderCommandHelp } from "@veyyon/utils/cli";

/**
 * A declared flag alias must actually parse and must actually appear in help.
 *
 * WHY THIS SUITE EXISTS (OUT-5). `FlagDescriptor` accepted an `aliases` field
 * and did nothing with it. The field survived because `Flags.string()` returns
 * `FlagDescriptor & T`, so any extra key type-checks and is carried along
 * inertly. Two flags in the shipped CLI were declared that way, one of them
 * `--yolo`, with a comment stating it was declared "so the auto-generated
 * --help lists it". Help never listed it. The alias was documentation that
 * documented nothing, and a reader of the source would have concluded the
 * opposite of the truth.
 *
 * That is the specific failure mode this suite exists for: a configuration key
 * that is silently ignored is worse than one that is rejected, because the
 * declaration looks like the feature working.
 *
 * Both halves are pinned, because either alone can regress independently: the
 * alias must PARSE into the canonical field (a command reads one name, whatever
 * the user typed), and it must RENDER on the canonical help line (not as a
 * second entry, which would read as a second behaviour).
 *
 * The collision check matters more than it looks. Registering an alias that
 * shadows a real flag would silently steal that flag's argv, so it throws at
 * declaration time rather than producing a CLI that misroutes one option.
 */

const CONFIG: CliConfig = { bin: "testbin", version: "0.0.0", commands: new Map() };

class AliasCommand extends Command {
	static description = "test command";
	static flags = {
		resume: Flags.string({ aliases: ["session", "restore"], description: "Resume a session" }),
		"auto-approve": Flags.boolean({ aliases: ["yolo"], description: "Approve everything" }),
		plain: Flags.string({ description: "No alias here" }),
	};
	async run(): Promise<void> {}
}

async function parseWith(argv: string[]): Promise<Record<string, unknown>> {
	const command = new AliasCommand(argv, CONFIG);
	const { flags } = await command.parse(AliasCommand);
	return flags as Record<string, unknown>;
}

/** Capture what `renderCommandHelp` writes to stdout. */
function helpText(): string {
	const original = process.stdout.write.bind(process.stdout);
	let captured = "";
	// Narrow stdout stub for one call.
	(process.stdout as any).write = (chunk: string) => {
		captured += chunk;
		return true;
	};
	try {
		renderCommandHelp("testbin", "alias-cmd", AliasCommand);
	} finally {
		// Restoring the stub.
		(process.stdout as any).write = original;
	}
	return captured;
}

describe("an alias parses into its canonical flag", () => {
	/**
	 * THE REGRESSION for a string flag. Before alias support this threw
	 * "Unknown option '--session'" in strict mode, so a documented alias was
	 * unusable.
	 */
	it("accepts a string flag's alias and stores it under the canonical name", async () => {
		const flags = await parseWith(["--session", "abc123"]);

		expect(flags.resume).toBe("abc123");
		expect(flags.session).toBeUndefined();
	});

	/** A second alias on the same flag works exactly as the first. */
	it("accepts every alias declared on one flag", async () => {
		const flags = await parseWith(["--restore", "xyz"]);

		expect(flags.resume).toBe("xyz");
	});

	/** THE REGRESSION for a boolean flag, which is the `--yolo` case. */
	it("accepts a boolean flag's alias", async () => {
		const flags = await parseWith(["--yolo"]);

		expect(flags["auto-approve"]).toBe(true);
	});

	/** The canonical spelling keeps working; the alias is an addition, not a move. */
	it("still accepts the canonical name", async () => {
		const flags = await parseWith(["--resume", "canonical"]);

		expect(flags.resume).toBe("canonical");
	});

	/**
	 * When both spellings are given, the canonical one wins. A user who typed both
	 * meant the flag the command reads, and silently preferring the alias would be
	 * the surprising choice.
	 */
	it("prefers the canonical value when both spellings are given", async () => {
		const flags = await parseWith(["--resume", "first", "--session", "second"]);

		expect(flags.resume).toBe("first");
	});

	/** A flag with no aliases is unaffected. */
	it("leaves an alias-free flag alone", async () => {
		const flags = await parseWith(["--plain", "value"]);

		expect(flags.plain).toBe("value");
	});

	/**
	 * Unknown flags are still rejected. Alias support widens the accepted set by
	 * exactly the declared aliases and not by one name more.
	 */
	it("still rejects an undeclared flag", async () => {
		await expect(parseWith(["--not-a-flag"])).rejects.toBeInstanceOf(CliUsageError);
	});

	/**
	 * An alias inherits its flag's value constraint. Skipping validation for the
	 * alias would make it a hole in the same check the canonical name passes.
	 */
	it("applies the options constraint to a value given through an alias", async () => {
		class ConstrainedCommand extends Command {
			static flags = {
				mode: Flags.string({ aliases: ["output"], options: ["text", "json"] }),
			};
			async run(): Promise<void> {}
		}
		const command = new ConstrainedCommand(["--output", "yaml"], CONFIG);

		await expect(command.parse(ConstrainedCommand)).rejects.toBeInstanceOf(CliUsageError);
	});
});

describe("an alias is visible in help", () => {
	/**
	 * THE OTHER HALF OF THE REGRESSION. A parseable alias nobody can discover is
	 * only half a feature, and discoverability was the stated reason the aliases
	 * were declared in the first place.
	 */
	it("lists the alias on the canonical flag's line", () => {
		const help = helpText();

		expect(help).toContain("--resume, --session, --restore");
	});

	/** The boolean case, which is the shipped `--yolo` declaration. */
	it("lists a boolean flag's alias", () => {
		const help = helpText();

		expect(help).toContain("--auto-approve, --yolo");
	});

	/**
	 * One entry, not two. A separate line per alias would read as separate flags
	 * with separate behaviour, which is exactly what an alias is not.
	 */
	it("does not give the alias its own entry", () => {
		const help = helpText();
		const lines = help.split("\n").filter(line => line.trim().startsWith("--"));

		expect(lines.filter(line => line.includes("--session"))).toHaveLength(1);
	});

	/**
	 * The description still renders and still belongs to the aliased entry.
	 *
	 * It is no longer necessarily on the SAME line, and that is the point of the layout rather than a
	 * regression. An alias chain is one of the widest entries help produces
	 * (`--resume, --session, --restore=<value>` is 43 characters), and the old renderer aligned every
	 * description to the widest entry, so this one flag pushed all seventy-odd descriptions into the
	 * right margin. An entry past the gutter now takes its own line and its description follows,
	 * indented to the description column, so the outlier costs one line instead of costing every
	 * other flag its readable width.
	 */
	it("keeps the description with the aliased entry", () => {
		const lines = helpText().split("\n");
		const index = lines.findIndex(line => line.includes("--resume, --session"));

		expect(index).toBeGreaterThanOrEqual(0);
		const entry = lines[index] ?? "";
		const next = lines[index + 1] ?? "";
		expect(`${entry}\n${next}`).toContain("Resume a session");
		// Wherever it landed, it is indented rather than starting a new column-0 entry.
		if (!entry.includes("Resume a session")) expect(next).toMatch(/^\s{4,}Resume a session/);
	});

	/** A flag with no aliases renders exactly as before. */
	it("leaves an alias-free flag's entry unchanged", () => {
		const help = helpText();

		expect(help).toMatch(/--plain=<value>\s+No alias here/);
	});
});

describe("an alias cannot shadow a real flag", () => {
	/**
	 * A colliding alias would silently steal the other flag's argv, which is a
	 * misrouted option rather than an error the author would ever see. It throws
	 * at parse-setup time so the mistake surfaces on the first invocation instead
	 * of as a bug report about a flag that "stopped working".
	 */
	it("throws when an alias collides with a declared flag", async () => {
		class CollidingCommand extends Command {
			static flags = {
				resume: Flags.string({ aliases: ["plain"] }),
				plain: Flags.string({}),
			};
			async run(): Promise<void> {}
		}
		const command = new CollidingCommand([], CONFIG);

		await expect(command.parse(CollidingCommand)).rejects.toThrow(/collides/);
	});
});

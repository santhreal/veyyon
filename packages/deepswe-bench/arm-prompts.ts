/**
 * Checking a `.prompts.yml` override against the prompt ids the benched build actually has.
 *
 * WHY THE RUNNER CHECKS THIS AT ALL. An override id that no registry holds is not a
 * crash, it is a silent no-op: the arm runs the shipped prompt while the results table
 * calls it a treatment, which is a zero-IV comparison wearing a name. The agent refuses
 * such an id at prompt assembly, so nothing is ever benched wrong — but that refusal
 * happens inside a container, once per trial, after the image is built and the quota is
 * committed. A typo in one YAML key is worth catching in the second before the run
 * starts, and this is where the run starts.
 *
 * The ids are read from the registries themselves, exactly as `run.ts` reads the
 * settings schema to decide whether an arm names a real setting. A list kept here would
 * go stale the first time a prompt is added, and a stale list refusing a valid id is
 * worse than no check.
 */
import { allPromptIds } from "@veyyon/coding-agent/prompts/all-registries";
import { nearestNames } from "@veyyon/utils";

/**
 * Every prompt id this tree can serve, sorted.
 *
 * Sorted because it is printed: an operator reading a refusal wants to scan for the id
 * they meant, and registry order is an implementation detail of the import graph.
 */
export function knownPromptIds(): readonly string[] {
	return [...allPromptIds()].sort();
}

/**
 * What is wrong with an arm's prompt override, or `null` when nothing is.
 *
 * Reports EVERY unknown id rather than the first. A `.prompts.yml` written by hand
 * usually gets a whole family of ids wrong the same way (a `tools/` prefix that is not
 * there, a `.md` left on the end), and fixing them one run at a time is the failure this
 * check exists to prevent.
 *
 * @param overrides the parsed `arms/<arm>.prompts.yml` mapping
 * @param known the id space to check against, defaulting to this build's
 */
export function promptOverrideIdError(
	arm: string,
	overrides: Readonly<Record<string, unknown>>,
	known: readonly string[] = knownPromptIds(),
): string | null {
	const unknownIds = Object.keys(overrides).filter(id => !known.includes(id));
	if (unknownIds.length === 0) return null;

	const detail = unknownIds
		.map(id => {
			const near = nearestNames(id, known, 3);
			return `  ${id}${near.length > 0 ? ` — did you mean ${near.join(", ")}?` : ""}`;
		})
		.join("\n");
	return (
		`arm "${arm}" arms/${arm}.prompts.yml names ${unknownIds.length} prompt id(s) that no registry holds:\n` +
		`${detail}\n` +
		`An id is the path under a registry's directory without .md (for example tools/bash, ` +
		`not tools/bash.md and not bash).\n` +
		`Fix: run \`veyyon prompt --prompts\` to list all ${known.length} ids, or drop the key.`
	);
}

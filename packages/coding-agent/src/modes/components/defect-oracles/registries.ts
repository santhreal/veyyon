/**
 * The registries, as data.
 *
 * WHY THIS EXISTS:
 * A registry was reachable only by importing its module by name, so everything that had to hold for
 * all of them was written once per registry: the corpus declared a family list by hand, mapped each
 * family to a guarantee list by hand, and a fourth registry was wired in by editing four places that
 * nothing forced to agree. A registry missing from one of them is not a compile error, it is a
 * registry with no reproductions, which is the shape a defect field hides in.
 *
 * Naming the registries here makes the corpus family axis a derived fact: `CorpusFamily` is the key of
 * this table, so adding a registry turns the corpus into a compile error until it declares how a case
 * of that family is read and replayed.
 *
 * WHAT IS NOT HERE:
 * How a state is produced or judged. This table carries the identity of a registry, not its evaluator:
 * the state types have nothing in common, and a table that tried to hold them would need one union per
 * field and would make every caller cast.
 */

import { COMPOSER_ORACLE_GUARANTEES, COMPOSER_ORACLES } from "./composer-defect-oracle";
import { DIFF_RENDER_ORACLE_GUARANTEES, DIFF_RENDER_ORACLES } from "./diff-render-defect-oracle";
import { MARKDOWN_ORACLE_GUARANTEES, MARKDOWN_ORACLES } from "./markdown-defect-oracle";
import { OVERLAY_ORACLE_GUARANTEES, OVERLAY_ORACLES } from "./overlay-defect-oracle";
import { TEXT_PRIMITIVE_ORACLE_GUARANTEES, TEXT_PRIMITIVE_ORACLES } from "./text-primitive-defect-oracle";
import { TOOL_RENDER_ORACLE_GUARANTEES, TOOL_RENDER_ORACLES } from "./tool-render-defect-oracle";

/** What every registry has in common: the ids it declares, and the entries it holds for them. */
export interface DefectOracleRegistry {
	/** The declared guarantee ids, in the order the registry states them. */
	guarantees: readonly string[];
	/** The keys of the registry's `Record`, which have to be exactly the declared ids. */
	entryIds: readonly string[];
	/** What the registry judges, for a failure message that names it. */
	subject: string;
}

export const DEFECT_ORACLE_REGISTRIES = {
	composer: {
		guarantees: COMPOSER_ORACLE_GUARANTEES,
		entryIds: Object.keys(COMPOSER_ORACLES),
		subject: "the composer zone of a painted frame",
	},
	overlay: {
		guarantees: OVERLAY_ORACLE_GUARANTEES,
		entryIds: Object.keys(OVERLAY_ORACLES),
		subject: "the modals composited over a frame",
	},
	toolRender: {
		guarantees: TOOL_RENDER_ORACLE_GUARANTEES,
		entryIds: Object.keys(TOOL_RENDER_ORACLES),
		subject: "the rows a tool renderer returns",
	},
	textPrimitive: {
		guarantees: TEXT_PRIMITIVE_ORACLE_GUARANTEES,
		entryIds: Object.keys(TEXT_PRIMITIVE_ORACLES),
		subject: "the text primitives every row goes through",
	},
	markdown: {
		guarantees: MARKDOWN_ORACLE_GUARANTEES,
		entryIds: Object.keys(MARKDOWN_ORACLES),
		subject: "the rows the markdown component returns",
	},
	diffRender: {
		guarantees: DIFF_RENDER_ORACLE_GUARANTEES,
		entryIds: Object.keys(DIFF_RENDER_ORACLES),
		subject: "the rows the diff renderer returns",
	},
} as const satisfies Readonly<Record<string, DefectOracleRegistry>>;

export type DefectOracleRegistryName = keyof typeof DEFECT_ORACLE_REGISTRIES;

/** The registry names, for a caller that sweeps them. */
export const DEFECT_ORACLE_REGISTRY_NAMES: readonly DefectOracleRegistryName[] = Object.keys(
	DEFECT_ORACLE_REGISTRIES,
) as DefectOracleRegistryName[];

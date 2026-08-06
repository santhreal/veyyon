/**
 * Bundled default rules shipped with the coding agent.
 *
 * Each markdown source is embedded via `with { type: "text" }` so it survives
 * `bun build --compile` (the compiled binary ships no loose rule files; only
 * the embedded text). The native source/tarball installs read the same modules.
 *
 * Registered by the lowest-priority `builtin-defaults` rule provider so any
 * user/project/tool rule with the same name overrides the bundled copy.
 *
 * The directory a rule lives in IS its section, and the section is the only
 * thing that decides how it is grouped on screen and whether it ships on. That
 * is one owner for a fact with two consumers, which is why there is no section
 * field in the rule's own frontmatter to disagree with the path, and no parsing
 * of the `ts-`/`rs-`/`go-` name prefix — a prefix is a naming convention, and a
 * project rule is free to pick one that means nothing.
 */
import argotLoadNudge from "./experimental/argot-load-nudge.md" with { type: "text" };
import goAddCleanup from "./go/go-add-cleanup.md" with { type: "text" };
import goBenchLoop from "./go/go-bench-loop.md" with { type: "text" };
import goExpPromoted from "./go/go-exp-promoted.md" with { type: "text" };
import goIoutil from "./go/go-ioutil.md" with { type: "text" };
import goJoinHostport from "./go/go-join-hostport.md" with { type: "text" };
import goNewExpr from "./go/go-new-expr.md" with { type: "text" };
import goRandV2 from "./go/go-rand-v2.md" with { type: "text" };
import goRangeInt from "./go/go-range-int.md" with { type: "text" };
import rsBoxLeak from "./rust/rs-box-leak.md" with { type: "text" };
import rsFuturePrelude from "./rust/rs-future-prelude.md" with { type: "text" };
import rsLazylock from "./rust/rs-lazylock.md" with { type: "text" };
import rsMatchErgonomics from "./rust/rs-match-ergonomics.md" with { type: "text" };
import rsParkingLot from "./rust/rs-parking-lot.md" with { type: "text" };
import rsResultType from "./rust/rs-result-type.md" with { type: "text" };
import tsBareCatch from "./typescript/ts-bare-catch.md" with { type: "text" };
import tsImportType from "./typescript/ts-import-type.md" with { type: "text" };
import tsNoAny from "./typescript/ts-no-any.md" with { type: "text" };
import tsNoDeprecatedLeftovers from "./typescript/ts-no-deprecated-leftovers.md" with { type: "text" };
import tsNoDynamicImport from "./typescript/ts-no-dynamic-import.md" with { type: "text" };
import tsNoInlineCastAccess from "./typescript/ts-no-inline-cast-access.md" with { type: "text" };
import tsNoReturnType from "./typescript/ts-no-return-type.md" with { type: "text" };
import tsNoTestTimers from "./typescript/ts-no-test-timers.md" with { type: "text" };
import tsNoTinyFunctions from "./typescript/ts-no-tiny-functions.md" with { type: "text" };
import tsPromiseWithResolvers from "./typescript/ts-promise-with-resolvers.md" with { type: "text" };
import tsRedundantClearGuard from "./typescript/ts-redundant-clear-guard.md" with { type: "text" };
import tsSetMap from "./typescript/ts-set-map.md" with { type: "text" };
import bashToolNudge from "./workflow/bash-tool-nudge.md" with { type: "text" };
import commitDrift from "./workflow/commit-drift.md" with { type: "text" };
import cwdReroot from "./workflow/cwd-reroot.md" with { type: "text" };
import projectAuthority from "./workflow/project-authority.md" with { type: "text" };
import testScope from "./workflow/test-scope.md" with { type: "text" };

/** The directories a bundled rule may live in. */
export type BuiltinRuleSection = "workflow" | "typescript" | "rust" | "go" | "experimental";

/** What a section is called on screen, and whether its rules ship enabled. */
export interface RuleSectionMeta {
	label: string;
	/**
	 * Off until the operator names the rule in `ttsr.experimentalRules`.
	 *
	 * A rule injects text into a live session, so shipping an unproven one on by
	 * default spends the operator's context on the author's behalf and gets
	 * blamed on the model. Opt-in is what makes the section safe to put things
	 * in, and therefore what makes it useful.
	 */
	experimental?: boolean;
}

/**
 * Section order and labels, in the order the settings screen renders them.
 *
 * Workflow first because it applies to every session regardless of language,
 * then the language sets alphabetically, then experimental last: a reader
 * scanning for what is running wants the always-relevant rules at the top and
 * the opt-in ones where they cannot be mistaken for defaults.
 */
export const BUILTIN_RULE_SECTIONS: Readonly<Record<BuiltinRuleSection, RuleSectionMeta>> = {
	workflow: { label: "Workflow" },
	go: { label: "Go" },
	rust: { label: "Rust" },
	typescript: { label: "TypeScript" },
	experimental: { label: "Experimental", experimental: true },
};

/** A bundled rule's stable name, section and raw markdown (frontmatter + body). */
export interface BuiltinRuleSource {
	name: string;
	section: BuiltinRuleSection;
	content: string;
}

/** All bundled default rules, ordered by section then name. */
export const BUILTIN_RULE_SOURCES: readonly BuiltinRuleSource[] = [
	{ name: "bash-tool-nudge", section: "workflow", content: bashToolNudge },
	{ name: "commit-drift", section: "workflow", content: commitDrift },
	{ name: "cwd-reroot", section: "workflow", content: cwdReroot },
	{ name: "project-authority", section: "workflow", content: projectAuthority },
	{ name: "test-scope", section: "workflow", content: testScope },
	{ name: "go-add-cleanup", section: "go", content: goAddCleanup },
	{ name: "go-bench-loop", section: "go", content: goBenchLoop },
	{ name: "go-exp-promoted", section: "go", content: goExpPromoted },
	{ name: "go-ioutil", section: "go", content: goIoutil },
	{ name: "go-join-hostport", section: "go", content: goJoinHostport },
	{ name: "go-new-expr", section: "go", content: goNewExpr },
	{ name: "go-rand-v2", section: "go", content: goRandV2 },
	{ name: "go-range-int", section: "go", content: goRangeInt },
	{ name: "rs-box-leak", section: "rust", content: rsBoxLeak },
	{ name: "rs-future-prelude", section: "rust", content: rsFuturePrelude },
	{ name: "rs-lazylock", section: "rust", content: rsLazylock },
	{ name: "rs-match-ergonomics", section: "rust", content: rsMatchErgonomics },
	{ name: "rs-parking-lot", section: "rust", content: rsParkingLot },
	{ name: "rs-result-type", section: "rust", content: rsResultType },
	{ name: "ts-bare-catch", section: "typescript", content: tsBareCatch },
	{ name: "ts-import-type", section: "typescript", content: tsImportType },
	{ name: "ts-no-any", section: "typescript", content: tsNoAny },
	{ name: "ts-no-deprecated-leftovers", section: "typescript", content: tsNoDeprecatedLeftovers },
	{ name: "ts-no-dynamic-import", section: "typescript", content: tsNoDynamicImport },
	{ name: "ts-no-inline-cast-access", section: "typescript", content: tsNoInlineCastAccess },
	{ name: "ts-no-return-type", section: "typescript", content: tsNoReturnType },
	{ name: "ts-no-test-timers", section: "typescript", content: tsNoTestTimers },
	{ name: "ts-no-tiny-functions", section: "typescript", content: tsNoTinyFunctions },
	{ name: "ts-promise-with-resolvers", section: "typescript", content: tsPromiseWithResolvers },
	{ name: "ts-redundant-clear-guard", section: "typescript", content: tsRedundantClearGuard },
	{ name: "ts-set-map", section: "typescript", content: tsSetMap },
	{ name: "argot-load-nudge", section: "experimental", content: argotLoadNudge },
];

/** Whether a bundled rule ships off, awaiting an explicit opt-in. */
export function isExperimentalSection(section: BuiltinRuleSection): boolean {
	return BUILTIN_RULE_SECTIONS[section].experimental === true;
}

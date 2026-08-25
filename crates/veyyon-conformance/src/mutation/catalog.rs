//! The mutation operators, and the classes that do not have one yet.
//!
//! Issue #877 names ten mutation classes. Six of them are a token substitution
//! in Rust source and are [`Operator`]s here. The other four are a statement
//! reorder, a call deletion, or a numeric policy change, and none of those can
//! be done soundly by replacing bytes: the rewrite either does not compile or
//! lands somewhere the report does not name. Those four are listed in
//! [`AWAITING_AST`] by name.
//!
//! Listing them is the point. A class with no operator and no row would be a
//! class nobody notices is missing, and the gate would pass while a third of
//! the campaign did not exist. [`ISSUE_CLASSES`] is the full set from the
//! issue, and the suite asserts that every member is either an operator or an
//! awaiting row, by exact equality — so a class added to the issue makes the
//! crate red until someone decides which side it falls on.

/// One token substitution.
///
/// `forbid_prev` and `forbid_next` keep a short operator from matching inside a
/// longer one: `<` must not match the `<` of `<=`, and `&&` must not match
/// inside `&&&`, which no compiler would accept anyway but which would waste a
/// build proving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Rewrite {
	pub before:      &'static str,
	pub after:       &'static str,
	pub forbid_prev: &'static [&'static str],
	pub forbid_next: &'static [&'static str],
}

impl Rewrite {
	/// A substitution with no neighbour restrictions.
	#[must_use]
	pub const fn plain(before: &'static str, after: &'static str) -> Self {
		Self { before, after, forbid_prev: &[], forbid_next: &[] }
	}

	/// The same substitution, refused when it would land inside a longer token.
	#[must_use]
	pub const fn bounded(
		before: &'static str,
		after: &'static str,
		forbid_prev: &'static [&'static str],
		forbid_next: &'static [&'static str],
	) -> Self {
		Self { before, after, forbid_prev, forbid_next }
	}

	/// Whether this rewrite may fire at `offset` in `source`.
	#[must_use]
	pub fn admissible_at(&self, source: &str, offset: usize) -> bool {
		let after = offset + self.before.len();
		let tail = source.get(after..).unwrap_or_default();
		if self
			.forbid_next
			.iter()
			.any(|forbidden| tail.starts_with(forbidden))
		{
			return false;
		}
		let head = source.get(..offset).unwrap_or_default();
		!self
			.forbid_prev
			.iter()
			.any(|forbidden| head.ends_with(forbidden))
	}
}

/// A class of deliberate defect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Operator {
	/// `<=` for `<`, and the rest of the off-by-one family.
	ComparisonBoundary,
	/// An equality or a guard that means the opposite of what it says.
	ConditionalInversion,
	/// A loop that never stops, because the terminal branch became a
	/// continuation.
	TerminalStateDeletion,
	/// An error that stops propagating, or a permission that defaults open.
	ValidationDeletion,
	/// A deadline three orders of magnitude further away, which is a deadline
	/// nobody reaches.
	TimeoutRelaxation,
	/// A parser that accepts more than its format allows.
	ParserAcceptanceBroadening,
}

impl Operator {
	/// Every operator, in declaration order.
	#[must_use]
	pub const fn all() -> [Self; 6] {
		[
			Self::ComparisonBoundary,
			Self::ConditionalInversion,
			Self::TerminalStateDeletion,
			Self::ValidationDeletion,
			Self::TimeoutRelaxation,
			Self::ParserAcceptanceBroadening,
		]
	}

	/// The stable id a report prints, and the id the mutant digest is taken
	/// over.
	#[must_use]
	pub const fn id(self) -> &'static str {
		match self {
			Self::ComparisonBoundary => "comparison-boundary",
			Self::ConditionalInversion => "conditional-inversion",
			Self::TerminalStateDeletion => "terminal-state-deletion",
			Self::ValidationDeletion => "validation-deletion",
			Self::TimeoutRelaxation => "timeout-relaxation",
			Self::ParserAcceptanceBroadening => "parser-acceptance-broadening",
		}
	}

	/// The substitutions this operator makes.
	#[must_use]
	pub const fn rewrites(self) -> &'static [Rewrite] {
		match self {
			Self::ComparisonBoundary => &COMPARISON_BOUNDARY,
			Self::ConditionalInversion => &CONDITIONAL_INVERSION,
			Self::TerminalStateDeletion => &TERMINAL_STATE_DELETION,
			Self::ValidationDeletion => &VALIDATION_DELETION,
			Self::TimeoutRelaxation => &TIMEOUT_RELAXATION,
			Self::ParserAcceptanceBroadening => &PARSER_ACCEPTANCE_BROADENING,
		}
	}

	/// The operator `id` names.
	///
	/// The ledger a campaign appends to is a persisted shape, so an id it
	/// wrote has to resolve back to an operator or the row is refused rather
	/// than silently attributed to the wrong class.
	#[must_use]
	pub fn from_id(id: &str) -> Option<Self> {
		Self::all().into_iter().find(|operator| operator.id() == id)
	}
}

/// Off-by-one in both directions. The widening rewrites refuse to fire inside
/// a two-character comparison or a `->`, which would produce bytes no compiler
/// accepts.
static COMPARISON_BOUNDARY: [Rewrite; 4] = [
	Rewrite::plain("<=", "<"),
	Rewrite::plain(">=", ">"),
	Rewrite::bounded("<", "<=", &["<"], &["=", "<"]),
	Rewrite::bounded(">", ">=", &[">", "-"], &["=", ">"]),
];

/// A guard that means the opposite of what it says.
static CONDITIONAL_INVERSION: [Rewrite; 5] = [
	Rewrite::plain("==", "!="),
	Rewrite::plain("!=", "=="),
	Rewrite::plain("if !", "if "),
	Rewrite::bounded("&&", "||", &["&"], &["&"]),
	Rewrite::bounded("||", "&&", &["|"], &["|"]),
];

/// A loop that never leaves, and a rejection that becomes an acceptance.
static TERMINAL_STATE_DELETION: [Rewrite; 2] =
	[Rewrite::plain("break;", "continue;"), Rewrite::plain("return None", "return Some(())")];

/// An error that stops propagating, and a permission that defaults open.
static VALIDATION_DELETION: [Rewrite; 3] = [
	Rewrite::plain("?;", ".ok();"),
	Rewrite::plain("unwrap_or(false)", "unwrap_or(true)"),
	Rewrite::plain("is_err()", "is_ok()"),
];

/// A deadline a thousand times further away, which is a deadline nobody waits
/// for.
static TIMEOUT_RELAXATION: [Rewrite; 2] = [
	Rewrite::plain("from_millis(", "from_secs("),
	Rewrite::plain("from_secs(", "from_secs(1000 * "),
];

/// A parser that takes more than its format allows.
static PARSER_ACCEPTANCE_BROADENING: [Rewrite; 3] = [
	Rewrite::plain("starts_with(", "contains("),
	Rewrite::plain("ends_with(", "contains("),
	Rewrite::plain("is_char_boundary(", "is_ascii().eq(&"),
];

impl std::fmt::Display for Operator {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.id())
	}
}

/// The classes issue #877 requires the campaign to execute.
pub static ISSUE_CLASSES: [&str; 10] = [
	"comparison-boundary",
	"conditional-inversion",
	"terminal-state-deletion",
	"validation-deletion",
	"timeout-relaxation",
	"parser-acceptance-broadening",
	"retry-backoff-change",
	"persistence-version-bypass",
	"tool-execution-before-validation",
	"sanitizer-removal",
];

/// The classes that need a real syntax tree, with the reason each one cannot be
/// a byte substitution.
pub static AWAITING_AST: [(&str, &str); 4] = [
	(
		"retry-backoff-change",
		"changes a numeric policy whose literal is not identifiable by its bytes",
	),
	("persistence-version-bypass", "deletes a guard expression, not a token inside one"),
	("tool-execution-before-validation", "reorders two statements"),
	("sanitizer-removal", "deletes a call and rebinds its argument"),
];


#[cfg(test)]
mod rewrite_pin_tests {
	use super::*;

	/// WHY: the mutation operator definitions are the campaign's source of
	/// truth. A mutation to any rewrite array (e.g. flipping `<` to `<=` in
	/// COMPARISON_BOUNDARY) changes what mutants are generated, silently
	/// weakening the gate. Pinning every array's exact contents catches any
	/// such drift.
	#[test]
	fn comparison_boundary_rewrites_are_pinned() {
		assert_eq!(COMPARISON_BOUNDARY.len(), 4);
		assert_eq!(COMPARISON_BOUNDARY[0], Rewrite::plain("<=", "<"));
		assert_eq!(COMPARISON_BOUNDARY[1], Rewrite::plain(">=", ">"));
		assert_eq!(COMPARISON_BOUNDARY[2], Rewrite::bounded("<", "<=", &["<"], &["=", "<"]));
		assert_eq!(COMPARISON_BOUNDARY[3], Rewrite::bounded(">", ">=", &[">", "-"], &["=", ">"]));
	}

	#[test]
	fn conditional_inversion_rewrites_are_pinned() {
		assert_eq!(CONDITIONAL_INVERSION.len(), 5);
		assert_eq!(CONDITIONAL_INVERSION[0], Rewrite::plain("==", "!="));
		assert_eq!(CONDITIONAL_INVERSION[1], Rewrite::plain("!=", "=="));
		assert_eq!(CONDITIONAL_INVERSION[2], Rewrite::plain("if !", "if "));
		assert_eq!(CONDITIONAL_INVERSION[3], Rewrite::bounded("&&", "||", &["&"], &["&"]));
		assert_eq!(CONDITIONAL_INVERSION[4], Rewrite::bounded("||", "&&", &["|"], &["|"]));
	}

	#[test]
	fn terminal_state_deletion_rewrites_are_pinned() {
		assert_eq!(TERMINAL_STATE_DELETION.len(), 2);
		assert_eq!(TERMINAL_STATE_DELETION[0], Rewrite::plain("break;", "continue;"));
		assert_eq!(TERMINAL_STATE_DELETION[1], Rewrite::plain("return None", "return Some(())"));
	}

	#[test]
	fn validation_deletion_rewrites_are_pinned() {
		assert_eq!(VALIDATION_DELETION.len(), 3);
		assert_eq!(VALIDATION_DELETION[0], Rewrite::plain("?;", ".ok();"));
		assert_eq!(VALIDATION_DELETION[1], Rewrite::plain("unwrap_or(false)", "unwrap_or(true)"));
		assert_eq!(VALIDATION_DELETION[2], Rewrite::plain("is_err()", "is_ok()"));
	}

	#[test]
	fn timeout_relaxation_rewrites_are_pinned() {
		assert_eq!(TIMEOUT_RELAXATION.len(), 2);
		assert_eq!(TIMEOUT_RELAXATION[0], Rewrite::plain("from_millis(", "from_secs("));
		assert_eq!(TIMEOUT_RELAXATION[1], Rewrite::plain("from_secs(", "from_secs(1000 * "));
	}

	#[test]
	fn parser_acceptance_broadening_rewrites_are_pinned() {
		assert_eq!(PARSER_ACCEPTANCE_BROADENING.len(), 3);
		assert_eq!(PARSER_ACCEPTANCE_BROADENING[0], Rewrite::plain("starts_with(", "contains("));
		assert_eq!(PARSER_ACCEPTANCE_BROADENING[1], Rewrite::plain("ends_with(", "contains("));
		assert_eq!(PARSER_ACCEPTANCE_BROADENING[2], Rewrite::plain("is_char_boundary(", "is_ascii().eq(&"));
	}
}
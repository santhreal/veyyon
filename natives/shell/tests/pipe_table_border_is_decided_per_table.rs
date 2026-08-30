//! An edge pipe is a border or a separator, and the TABLE decides which.
//!
//! THE QUESTION. A pipe row's outer pipes mean one of two things. In psql's
//! default aligned output there are none, so every pipe separates columns:
//! `  1 | grace` is two cells, and `  1 | ` is also two cells, the second
//! empty. In a bordered table (`aws --output table`, a Markdown table, psql
//! with borders on) every row is wrapped: `| a | b |` is two cells and the
//! outer pipes are decoration that must come off.
//!
//! THE BUG THIS SUITE LOCKS OUT. `normalize_pipe_row` used to trim pipes off
//! both ends of every row unconditionally, deciding the question per ROW. From
//! a single row it is undecidable: `  1 | ` is a bordered row missing its left
//! border, or an unbordered row with an empty last cell, and nothing in that
//! line says which. Trimming picked the border reading always, so an unbordered
//! row whose last cell was empty came back as `1` instead of `1\t`, one column
//! short. A reader of the compacted output saw a one-column row where the query
//! had returned two, and nothing announced the loss. An interior empty cell was
//! never affected, which is what kept it hidden: the common case read
//! correctly.
//!
//! WHY THE TABLE CAN ANSWER IT. An aligned renderer draws the outer border on
//! every row or on none. So `detect_pipe_border_style` looks at all of a
//! table's pipe rows at once: every one wrapped means the pipes are a border,
//! and one row that is not makes them separators everywhere. The mixed case is
//! a fragment or hand-written text, where reading an edge pipe as decoration
//! would delete a real column, so it resolves to the reading that keeps the
//! data.
//!
//! Filed as PSQL-TRAILING-EMPTY-COLUMN-IS-DROPPED. The blank-row rule that
//! `pipe_table_rows_that_say_nothing_are_dropped.rs` covers is unaffected and
//! still applies on top: a row of only empty cells is dropped whichever reading
//! the table gets.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

mod common;

use common::{context, enabled};

const fn psql<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	context("psql", Some("log"), command, config)
}

const fn aws<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	context("aws", Some("ec2"), command, config)
}

fn compact(ctx: &MinimizerCtx<'_>, input: &str) -> String {
	filters::filter(ctx, input, 0).text
}

mod an_unbordered_table_keeps_its_edge_cells {
	use super::*;

	/// THE regression, in the shape the ledger row describes.
	///
	/// psql's default output has no outer pipes, so the trailing `|` on row 1 is
	/// a separator and the cell after it is a real empty column. Asserted as an
	/// exact line rather than a substring, because `contains("1")` passes on the
	/// broken output too.
	#[test]
	fn a_trailing_separator_yields_a_real_empty_last_cell() {
		let config = enabled();
		let ctx = psql("psql -c 'select id, name from users'", &config);
		let input = " id | name \n----+------\n  1 | \n  2 | grace\n(2 rows)\n";

		let out = compact(&ctx, input);

		let lines: Vec<&str> = out.lines().collect();
		assert!(lines.contains(&"id\tname"), "header: {out:?}");
		assert!(lines.contains(&"1\t"), "the empty last column is a column: {out:?}");
		assert!(lines.contains(&"2\tgrace"), "the complete row is unchanged: {out:?}");
	}

	/// The mirror at the other edge. A LEADING separator means an empty FIRST
	/// column, which the old trim removed just as silently.
	#[test]
	fn a_leading_separator_yields_a_real_empty_first_cell() {
		let config = enabled();
		let ctx = psql("psql -c 'select code, name from t'", &config);
		let input = " code | name \n------+------\n | ada\n b | grace\n(2 rows)\n";

		let out = compact(&ctx, input);

		let lines: Vec<&str> = out.lines().collect();
		assert!(lines.contains(&"\tada"), "the empty first column is a column: {out:?}");
		assert!(lines.contains(&"b\tgrace"), "and the complete row is unchanged: {out:?}");
	}

	/// Both edges empty at once, which is the case a per-row rule got doubly
	/// wrong: it removed two columns and left a three-column row reading as one.
	#[test]
	fn both_edges_empty_keeps_all_three_columns() {
		let config = enabled();
		let ctx = psql("psql -c 'select a, b, c from t'", &config);
		let input = " a | b | c \n---+---+---\n | ada | \n x | grace | y \n(2 rows)\n";

		let out = compact(&ctx, input);

		let lines: Vec<&str> = out.lines().collect();
		assert!(lines.contains(&"\tada\t"), "both edge columns survive: {out:?}");
		assert!(lines.contains(&"x\tgrace\ty"), "and the complete row is unchanged: {out:?}");
	}

	/// A row with no empty cells at all is byte-identical under either reading,
	/// so it is the control: it proves the change did not start inserting tabs.
	#[test]
	fn an_ordinary_unbordered_row_gains_no_tabs() {
		let config = enabled();
		let ctx = psql("psql -c 'select id, name from users'", &config);
		let input = " id | name \n----+------\n  1 | ada\n(1 row)\n";

		let out = compact(&ctx, input);

		assert!(out.lines().any(|line| line == "1\tada"), "exactly two cells: {out:?}");
		assert!(!out.contains("\t\t"), "no empty cell was invented: {out:?}");
	}
}

mod a_bordered_table_still_has_its_border_trimmed {
	use super::*;

	/// The reason the unconditional trim existed, and it must keep working.
	/// Every row here is wrapped, so the outer pipes are decoration: no leading
	/// or trailing tab may appear.
	#[test]
	fn a_fully_bordered_table_gains_no_edge_cells() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let input = "+------+-------+\n| id   | name  |\n+------+-------+\n| i-01 | web   |\n| i-02 \
		             | db    |\n+------+-------+\n";

		let out = compact(&ctx, input);

		for line in out.lines() {
			assert!(!line.starts_with('\t'), "a border became an empty first cell: {out:?}");
			assert!(!line.ends_with('\t'), "a border became an empty last cell: {out:?}");
		}
		let lines: Vec<&str> = out.lines().collect();
		assert!(lines.contains(&"id\tname"), "header: {out:?}");
		assert!(lines.contains(&"i-01\tweb"), "first row: {out:?}");
		assert!(lines.contains(&"i-02\tdb"), "second row: {out:?}");
	}

	/// A bordered table WITH an empty cell, which is where the two readings
	/// would visibly disagree. The cell is interior, so it survives as an empty
	/// column, and the borders still come off.
	#[test]
	fn a_bordered_row_with_an_empty_middle_cell_keeps_the_column_and_loses_the_border() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let input = "+------+------+------+\n| a    | b    | c    |\n+------+------+------+\n| i-01 \
		             |      | web  |\n+------+------+------+\n";

		let out = compact(&ctx, input);

		assert!(out.lines().any(|line| line == "i-01\t\tweb"), "three cells, middle empty: {out:?}");
	}

	/// A single bordered row with nothing to compare against. `| a | b |` on its
	/// own is the one shape where the two readings differ and the border reading
	/// is right, so the detector's answer for a table whose every row is wrapped
	/// must not depend on how many rows there are.
	#[test]
	fn one_bordered_row_is_read_as_bordered() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let input = "+---+---+\n| a | b |\n+---+---+\n";

		let out = compact(&ctx, input);

		assert!(out.lines().any(|line| line == "a\tb"), "no edge cells: {out:?}");
	}
}

mod a_table_cannot_be_half_bordered {
	use super::*;

	/// ONE unwrapped row makes the whole table unbordered, and the reason is
	/// which mistake is recoverable. Reading a separator as a border DELETES a
	/// column with no trace. Reading a border as a separator adds a visible
	/// empty cell, which a reader can see and discount. So the mixed case
	/// resolves to the reading that keeps the data.
	#[test]
	fn a_single_unwrapped_row_makes_every_row_unbordered() {
		let config = enabled();
		let ctx = psql("psql -c 'select a, b from t'", &config);
		// Row 2 is wrapped, row 1 is not: this is not a bordered table.
		let input = " a | b \n---+---\n x | y \n| p | q |\n(2 rows)\n";

		let out = compact(&ctx, input);

		let lines: Vec<&str> = out.lines().collect();
		assert!(lines.contains(&"x\ty"), "the unwrapped row is unchanged: {out:?}");
		assert!(
			lines.contains(&"\tp\tq\t"),
			"the wrapped row's edge pipes are separators here: {out:?}"
		);
	}

	/// The header alone deciding it would be the same per-row mistake one level
	/// up. Here the HEADER is wrapped and a data row is not, so the table is
	/// still unbordered.
	#[test]
	fn a_wrapped_header_over_unwrapped_rows_is_unbordered() {
		let config = enabled();
		let ctx = psql("psql -c 'select a, b from t'", &config);
		let input = "| a | b |\n---+---\n x | \n(1 row)\n";

		let out = compact(&ctx, input);

		let lines: Vec<&str> = out.lines().collect();
		assert!(lines.contains(&"\ta\tb\t"), "the header keeps its edge cells: {out:?}");
		assert!(lines.contains(&"x\t"), "and so does the row that revealed the style: {out:?}");
	}
}

mod the_blank_row_rule_still_applies_on_top {
	use super::*;

	/// A row of only empty cells is still dropped, under either reading. This is
	/// the interaction that could have broken: under the unbordered reading
	/// `"|"` splits into two empty cells and normalizes to a lone tab, which is
	/// not the empty string, so a naive check would emit it and put a
	/// whitespace-only line into the output. That is the blank-line regression
	/// `pipe_table_rows_that_say_nothing_are_dropped.rs` exists for, reached
	/// through a different door.
	#[test]
	fn a_lone_pipe_is_still_dropped_in_an_unbordered_table() {
		let config = enabled();
		let ctx = psql("psql -c 'select id from t'", &config);
		let input = " id \n----\n  1\n|\n  2\n(2 rows)\n";

		let out = compact(&ctx, input);

		for line in out.lines() {
			assert!(!line.trim().is_empty(), "a row that says nothing was emitted: {out:?}");
		}
		assert!(out.contains('1') && out.contains('2'), "the real rows survive: {out:?}");
	}

	/// And a row of separators with nothing between them, which normalizes to
	/// tabs only. Same rule, larger row.
	#[test]
	fn a_row_of_only_separators_is_dropped() {
		let config = enabled();
		let ctx = psql("psql -c 'select a, b, c from t'", &config);
		let input = " a | b | c \n---+---+---\n x | y | z \n | | \n(2 rows)\n";

		let out = compact(&ctx, input);

		for line in out.lines() {
			assert!(!line.trim().is_empty(), "an all-empty row was emitted: {out:?}");
		}
		assert!(out.lines().any(|line| line == "x\ty\tz"), "the real row survives: {out:?}");
	}
}

mod the_answer_settles_after_one_pass {
	use super::*;

	/// Filters chain and captures get replayed, so a compactor whose answer
	/// depends on how many times it has run cannot be cached or compared across
	/// runs. The compacted output has no pipes left, so the second pass must be
	/// a no-op. Four passes, because a fix that merely alternated between two
	/// answers would satisfy a single repeat.
	#[test]
	fn an_unbordered_table_with_empty_edge_cells_is_stable() {
		let config = enabled();
		let ctx = psql("psql -c 'select a, b from t'", &config);
		let mut text = compact(&ctx, " a | b \n---+---\n | x \n y | \n(2 rows)\n");
		let expected = text.clone();

		for pass in 1..=4 {
			text = compact(&ctx, &text);
			assert_eq!(text, expected, "pass {pass} rewrote a settled table");
		}
		assert!(
			expected.lines().any(|line| line == "\tx"),
			"and the answer is the right one: {expected:?}"
		);
		assert!(expected.lines().any(|line| line == "y\t"), "at both edges: {expected:?}");
	}

	/// The bordered table settles too, and to the border reading. A pass that
	/// re-examined its own tab-separated output could not change the answer, but
	/// pinning it means a future pass that reintroduces pipes cannot flip it
	/// silently.
	#[test]
	fn a_bordered_table_is_stable() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let mut text = compact(&ctx, "+---+---+\n| a | b |\n+---+---+\n| x | y |\n+---+---+\n");
		let expected = text.clone();

		for pass in 1..=4 {
			text = compact(&ctx, &text);
			assert_eq!(text, expected, "pass {pass} rewrote a settled table");
		}
		assert!(expected.lines().any(|line| line == "x\ty"), "the border stayed off: {expected:?}");
	}
}

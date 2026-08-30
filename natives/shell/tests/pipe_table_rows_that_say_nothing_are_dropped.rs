//! Compacting a pipe table never emits a row that is not a row.
//!
//! WHAT THE FILTERS DO. `psql` prints a bordered table: a header row of pipe
//! separated cells, a `-+-` border, the data rows, then `(N rows)`. `aws
//! --output table` prints the same shape with `+---+` borders. Both compactors
//! drop the borders and the blank lines, turn each pipe row into tab separated
//! cells, cap the number of data rows, and keep whatever summary line follows.
//!
//! THE BUG. A pipe row whose cells are all empty normalizes to the empty
//! string, and both compactors pushed it anyway. The result was a BLANK LINE in
//! the output, which is exactly what each loop's first step drops on the way
//! in. So filtering the output again removed the blank, and the same capture
//! minimized to two different things depending on how many times it had been
//! through: psql turned `"-+-\r-\n|\n(/[\n"` into `"-+-\r-\n\n(/[\n"` on one
//! pass and `"-+-\r-\n(/[\n"` on the next. Filters chain and captures get
//! replayed, so a filter whose answer depends on how many times it has run
//! cannot be cached, compared across runs, or replayed. Found by
//! `fuzz/fuzz_targets/minimizer_filters.rs`.
//!
//! WHY BOTH COMPACTORS ARE TESTED HERE. They are the same shape, and fixing
//! only the psql one left the fuzzer to find the aws one an hour later. The
//! skip has a single owner now (`normalize_pipe_row_if_meaningful`) and both
//! sides of it are pinned, so the next person to touch one compactor cannot
//! silently leave the other behind.
//!
//! This is the same class as the log-compaction blank run in
//! `filters_do_not_consume_their_own_output.rs`: nothing here misreads an
//! annotation, the filter simply produces something its own entry conditions
//! reject.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

mod common;

use common::{context, enabled};

const fn psql<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	context("psql", Some("log"), command, config)
}

const fn aws<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	context("aws", Some("ec2"), command, config)
}

/// Filter `input`, then filter the result, and return both.
fn two_passes(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> (String, String) {
	let first = filters::filter(ctx, input, exit_code).text;
	let second = filters::filter(ctx, &first, exit_code).text;
	(first, second)
}

mod psql_drops_an_empty_row_rather_than_emitting_it_blank {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	///
	/// The lone `|` is a pipe row with no cells. It used to be normalized to the
	/// empty string and pushed as the header, putting a blank line between the
	/// two surrounding lines that the next pass then removed.
	#[test]
	fn a_lone_pipe_does_not_become_a_blank_line() {
		let config = enabled();
		let ctx = psql("", &config);
		let (first, second) = two_passes(&ctx, "-+-\r-\n|\n(/[\n\n\n\n", 2);

		assert!(!first.contains("\n\n"), "no blank line may survive the first pass: {first:?}");
		assert_eq!(second, first, "and the second pass must find nothing left to drop");
	}

	/// A row of empty cells is dropped too, not just a bare pipe.
	///
	/// `"|  |"` normalizes to a tab and no content. It is still a row that says
	/// nothing, and emitting it would put a line of whitespace where the
	/// filter's own entry condition expects none.
	#[test]
	fn a_row_of_empty_cells_is_dropped() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1'", &config);
		let input = " id | name \n----+------\n  1 | ada\n|  |\n  2 | grace\n(2 rows)\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(first.contains("id\tname"), "the real header survives: {first:?}");
		assert!(first.contains("1\tada"), "and the real rows: {first:?}");
		assert!(first.contains("2\tgrace"), "all of them: {first:?}");
		assert_eq!(second, first, "and the empty row leaves nothing behind");
	}

	/// The real header is still the header after an empty row is dropped.
	///
	/// The negative twin, and the reason the skip is placed BEFORE the header
	/// bookkeeping rather than after: if an empty row had claimed the header
	/// slot, the first real row would have been counted as data and the column
	/// names would have been capped away on a wide result.
	#[test]
	fn an_empty_row_before_the_header_does_not_claim_the_header_slot() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1'", &config);
		let input = "|\n id | name \n----+------\n  1 | ada\n(1 row)\n";
		let first = filters::filter(&ctx, input, 0).text;

		let mut lines = first.lines().filter(|line| line.contains('\t'));
		assert_eq!(lines.next(), Some("id\tname"), "the column names come first: {first:?}");
		assert_eq!(lines.next(), Some("1\tada"), "then the data: {first:?}");
	}
}

mod the_aws_table_compactor_has_the_same_rule {
	use super::*;

	/// THE regression on the other compactor, as the fuzzer reduced it.
	///
	/// The same `|` row, reached through `compact_delimited_table` rather than
	/// `compact_psql_table`. This one was found an hour after the psql fix
	/// landed, which is why the skip now has a single owner.
	#[test]
	fn a_lone_pipe_does_not_become_a_blank_line() {
		let config = enabled();
		let ctx = aws("", &config);
		let (first, second) =
			two_passes(&ctx, " \n[\n|\n\nx|\n\n\n|\u{1b}\nx|\n\r \n+-\t+\n\n\n", 143);

		assert!(!first.contains("\n\n"), "no blank line may survive the first pass: {first:?}");
		assert_eq!(second, first, "and the second pass must find nothing left to drop");
	}

	/// An empty row inside a bordered aws table is dropped and the rest stands.
	#[test]
	fn an_empty_row_inside_a_bordered_table_is_dropped() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let input =
			"+--------------+----------+\n|  InstanceId  |  State   \
			 |\n+--------------+----------+\n|  i-0abc      |  running |\n|              |          \
			 |\n|  i-0def      |  stopped |\n+--------------+----------+\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(first.contains("InstanceId\tState"), "the header is reshaped: {first:?}");
		assert!(first.contains("i-0abc\trunning"), "and the rows: {first:?}");
		assert!(first.contains("i-0def\tstopped"), "all of them: {first:?}");
		assert!(!first.contains("\n\n"), "and the empty row is gone, not blank: {first:?}");
		assert_eq!(second, first, "which leaves the second pass nothing to do");
	}

	/// And the empty row does not claim the header slot here either.
	#[test]
	fn an_empty_row_before_the_header_does_not_claim_the_header_slot() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let input =
			"+---+---+\n|   |   |\n|  Name  |  Id  |\n+---+---+\n|  web  |  1  |\n+---+---+\n";
		let first = filters::filter(&ctx, input, 0).text;

		let mut lines = first.lines();
		assert_eq!(lines.next(), Some("Name\tId"), "the column names come first: {first:?}");
		assert_eq!(lines.next(), Some("web\t1"), "then the data: {first:?}");
	}
}

mod a_row_that_normalizes_into_a_border_is_dropped_too {
	use super::*;

	/// THE second regression, found after the blank-row fix landed.
	///
	/// Normalizing strips the pipes and the padding, so a row can BECOME a
	/// border that was not one before. `"|-+-\r|"` is not a border, because a
	/// carriage return is not a border character, and it normalized to `"-+-"`,
	/// which is. Pass one emitted that as the header; pass two classified it as
	/// a border, dropped it, and promoted the row below into the header slot.
	/// The rule the fix states is broader than either case: a compactor must
	/// never emit a line its own loop would drop on the way in.
	#[test]
	fn a_row_that_becomes_a_border_when_normalized_is_dropped() {
		let config = enabled();
		let ctx = psql("", &config);
		let (first, second) = two_passes(&ctx, "|-+-\r\u{1b}|\n(\u{1b}])\n\n\n", i32::MIN);

		assert_eq!(first, "(])\n", "the border-shaped row never reaches the output: {first:?}");
		assert_eq!(second, first, "so there is nothing for a second pass to reclassify");
	}

	/// The aws compactor has the same rule, through its own detector.
	#[test]
	fn the_aws_compactor_drops_a_row_that_becomes_a_border() {
		let config = enabled();
		let ctx = aws("aws ec2 describe-instances --output table", &config);
		let input = "+-----+\n|-----|\n|  ok |\n+-----+\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(first.contains("ok"), "the real row survives: {first:?}");
		assert_eq!(second, first, "and the border-shaped row is gone for good");
	}

	/// A row of dashes that is a real CELL VALUE keeps its columns and stays.
	///
	/// The boundary of the rule, and the reason it is scoped to what
	/// `is_border_line` accepts: a multi-cell row normalizes to tab separated
	/// cells, a tab is not a border character, and so a genuine `-` placeholder
	/// in a table is never mistaken for decoration.
	#[test]
	fn a_dash_cell_inside_a_multi_column_row_is_kept() {
		let config = enabled();
		let ctx = psql("psql -c 'select id, note from t'", &config);
		let input = " id | note \n----+------\n  1 | -\n  2 | ok\n(2 rows)\n";
		let first = filters::filter(&ctx, input, 0).text;

		assert!(first.contains("1\t-"), "the dash is a value, not a border: {first:?}");
		assert!(first.contains("2\tok"), "and the other row is untouched: {first:?}");
	}
}

mod ordinary_table_output_is_unaffected {
	use super::*;

	/// A normal psql result set still compacts, which is what the filter is for.
	#[test]
	fn a_bordered_psql_table_is_compacted_to_tab_separated_rows() {
		let config = enabled();
		let ctx = psql("psql -c 'select id, name from users'", &config);
		let input = " id | name  \n----+-------\n  1 | ada\n  2 | grace\n(2 rows)\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(first.contains("id\tname"), "got: {first:?}");
		assert!(first.contains("1\tada"), "got: {first:?}");
		assert!(first.contains("(2 rows)"), "the count line is kept: {first:?}");
		assert!(!first.contains("----+"), "the border is dropped: {first:?}");
		assert_eq!(second, first, "and the compacted table settles after one pass");
	}

	/// An empty result keeps its count line rather than collapsing to nothing.
	///
	/// The boundary the skip must not cross: zero rows is a real answer, and the
	/// `(0 rows)` line is the only thing that says so.
	#[test]
	fn an_empty_result_set_keeps_its_count_line() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1 where false'", &config);
		let first = filters::filter(&ctx, " id | name \n----+------\n(0 rows)\n", 0).text;

		assert!(first.contains("(0 rows)"), "the count is the whole result: {first:?}");
		assert!(first.contains("id\tname"), "and the columns are still named: {first:?}");
	}

	/// A row whose LAST cell is empty is still a row and is still kept.
	///
	/// The narrow boundary of the rule: the skip is for a row where EVERY cell
	/// is empty. A NULL in one column is data, and dropping the record would
	/// lose something the query returned.
	///
	/// It keeps BOTH columns, as `1\t`, which is what fixing
	/// PSQL-TRAILING-EMPTY-COLUMN-IS-DROPPED changed. It used to come back as
	/// `1`: the row was normalized by trimming pipes off both ends, so a
	/// trailing separator was indistinguishable from the right-hand border of a
	/// `| a | b |` table and the empty last column went with it. A reader of the
	/// compacted output saw a one-column row where the query returned two, and
	/// nothing said a column had been dropped. The border question is decided
	/// once per TABLE now (`detect_pipe_border_style`), and this table has no
	/// outer pipes anywhere, so the trailing pipe is a separator and the cell
	/// after it is real.
	#[test]
	fn a_row_whose_last_cell_is_empty_keeps_both_columns() {
		let config = enabled();
		let ctx = psql("psql -c 'select id, name from users'", &config);
		let input = " id | name \n----+------\n  1 | \n  2 | grace\n(2 rows)\n";
		let first = filters::filter(&ctx, input, 0).text;

		assert!(first.contains("\n1\t\n"), "the empty last column is still a column: {first:?}");
		assert!(first.contains("2\tgrace"), "and the complete record is unchanged: {first:?}");
		assert!(first.contains("id\tname"), "the header names both columns: {first:?}");
		assert!(
			first.contains("(2 rows)"),
			"the count still matches what the query returned: {first:?}"
		);
	}

	/// A row whose MIDDLE cell is empty keeps both separators, so the column
	/// count is visible.
	///
	/// The contrast that made the bug above findable: an interior empty cell is
	/// never next to a border, so nothing trimmed it and the row always read
	/// correctly. Both cases agree now, and this one is kept because it is the
	/// case that never depended on the border decision at all.
	#[test]
	fn a_row_with_an_empty_middle_cell_keeps_its_columns() {
		let config = enabled();
		let ctx = psql("psql -c 'select id, name, email from users'", &config);
		let input = " id | name | email \n----+------+-------\n  1 |  | ada@example.com\n(1 row)\n";
		let first = filters::filter(&ctx, input, 0).text;

		assert!(
			first.contains("1\t\tada@example.com"),
			"the empty column is still a column: {first:?}"
		);
	}

	/// Compacted output stays fixed across several passes, since a fix that
	/// merely alternated between two answers would satisfy a single repeat.
	#[test]
	fn a_compacted_table_stays_fixed_across_repeated_passes() {
		let config = enabled();
		let ctx = psql("psql -c 'select id from t'", &config);
		let mut text = filters::filter(&ctx, " id \n----\n  1\n|\n  2\n(2 rows)\n", 0).text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 0).text;
			assert_eq!(text, expected, "pass {pass} rewrote a settled table");
		}
	}
}

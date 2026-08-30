//! Figures and sections that are read, not chosen from.
//!
//! A section's body is a sequence of view kinds, drawn through
//! `veyyon_gui_views::view`. That is the whole reason the report shape carries
//! no rows of its own: the usage table in a report and the same table in the
//! transcript are one renderer, so they cannot disagree about a column.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::screen::{Report, ReportSection, ReportStat};
use veyyon_gui_kit::{
	Level,
	chrome::{column, row, rule},
	surface,
	text::{caption, label, text_in},
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;
use veyyon_gui_views::tone;

pub fn report(value: &Report, cx: &App) -> Div {
	let mut stack = column(space::BASE);
	if !value.summary.is_empty() {
		stack = stack.child(
			row(space::WIDE)
				.flex_wrap()
				.children(value.summary.iter().map(|s| stat(s, cx))),
		);
	}
	stack = stack.children(
		value
			.sections
			.iter()
			.map(|section| self::section(section, cx)),
	);
	match &value.footer {
		None => stack,
		Some(footer) => stack.child(caption(footer.clone(), cx)),
	}
}

/// One headline figure: the value large, its label under it.
///
/// The value above the label rather than beside it, because the figures are
/// read across as a row and a label-first layout makes the numbers the second
/// column of a table nobody is reading.
fn stat(value: &ReportStat, cx: &App) -> Div {
	surface(Level::Raised, cx)
		.p(space::SNUG)
		.rounded(radius::SMALL)
		.flex()
		.flex_col()
		.gap(space::HAIR)
		.child(text_in(value.value.clone(), tone::role(value.tone), text::TITLE, cx))
		.child(label(value.label.clone(), cx))
}

/// One section: its heading, then its body or what it has to say instead.
fn section(value: &ReportSection, cx: &App) -> Div {
	let mut stack = column(space::SNUG);
	if let Some(heading) = &value.heading {
		stack = stack
			.child(text_in(heading.clone(), Role::TextPrimary, text::BODY, cx))
			.child(rule(Role::StrokeSubtle, cx));
	}
	if value.body.is_empty() {
		return stack.child(caption(empty_text(value), cx));
	}
	stack.children(
		value
			.body
			.iter()
			.map(|part| veyyon_gui_views::view(part, cx)),
	)
}

/// What an empty section says.
///
/// A section with an empty body and nothing said in its place reads as a
/// section that failed to load. The shape carries the sentence when the
/// producer knows a better one; this is the fallback, not a second opinion
/// about the first.
pub fn empty_text(value: &ReportSection) -> String {
	match &value.empty {
		Some(text) => text.clone(),
		None => EMPTY_SECTION.to_owned(),
	}
}

/// What a section with no body and no sentence of its own says.
const EMPTY_SECTION: &str = "nothing to report";

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A report is assembled from several producers, and one short row shifts a
	//! whole column of a table that still looks like a table. The fixture is
	//! swept for alignment across every section, so a shifted table cannot reach
	//! a window through a report that looked fine section by section.
	//!
	//! The empty section is the other failure: a body that is empty and says
	//! nothing reads as a section that failed to load, which is
	//! indistinguishable on screen from one that has nothing in it.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the figures are correct. The report draws
	//! what the producer reports and does no arithmetic of its own.

	use veyyon_gui_contract::{fixtures, view::View};

	use super::*;

	#[test]
	fn every_table_in_the_report_has_rows_that_match_its_header() {
		let report = fixtures::routes::usage();
		for (index, section) in report.sections.iter().enumerate() {
			assert!(
				section.is_aligned(),
				"section {index} carries a table whose rows do not match its header"
			);
		}
		assert!(
			report
				.sections
				.iter()
				.flat_map(|section| section.body.iter())
				.any(|part| matches!(part, View::Table(_))),
			"nothing in the report exercises the alignment check"
		);
	}

	#[test]
	fn an_empty_section_says_something_rather_than_drawing_a_gap() {
		let report = fixtures::routes::usage();
		let empty = report
			.sections
			.iter()
			.find(|section| section.body.is_empty())
			.expect("the fixture carries an empty section");
		assert!(!empty_text(empty).is_empty());
	}

	#[test]
	fn a_section_with_no_sentence_of_its_own_falls_back_rather_than_going_blank() {
		let bare = ReportSection::new(Vec::new());
		assert_eq!(empty_text(&bare), EMPTY_SECTION);
	}

	#[test]
	fn a_producers_own_sentence_wins_over_the_fallback() {
		let stated = ReportSection::new(Vec::new()).empty_text("no requests this month");
		assert_eq!(empty_text(&stated), "no requests this month");
	}

	#[test]
	fn the_figures_carry_the_verdicts_the_producer_gave_them() {
		let report = fixtures::routes::usage();
		assert!(!report.summary.is_empty(), "the report has no headline figures");
		assert!(
			report.summary.iter().any(|stat| stat.tone.is_some()),
			"no figure carries a tone, so nothing exercises the mapping"
		);
	}
}

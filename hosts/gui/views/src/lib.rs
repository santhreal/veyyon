//! This host's drawing of the view contract.
//!
//! A tool reports what it did as a sequence of [`View`] parts; it never decides
//! how they read. This crate turns each part into a window element. The
//! terminal host draws the same parts into cells, and neither knows the other
//! exists: two hosts drawing one vocabulary is what makes it a contract rather
//! than one front end's internal shape.
//!
//! # The two rules the whole crate follows
//!
//! - A colour is never written literally. A module names a
//!   [`veyyon_gui_theme::Role`] and reads it through the active palette, so a
//!   theme change reaches every kind.
//! - A size is never written literally. Sizes come from
//!   `veyyon_gui_kit::tokens`, so a theme change cannot move a pixel and a
//!   spacing change is one edit.
//!
//! Where a tone becomes an appearance is [`tone`], once, rather than a match at
//! each call site: the same [`veyyon_gui_contract::view::Tone`] resolving to
//! two different roles in two kinds is a defect neither kind looks wrong
//! committing.
//!
//! # What is not drawn
//!
//! Syntax highlighting, markdown beyond paragraphs and bullets, and image
//! bytes. Each is stated in the module that would draw it, with what it does
//! instead.

#![allow(
	clippy::tabs_in_doc_comments,
	reason = "the workspace sets hard_tabs and format_code_in_doc_comments, so the formatter \
	          writes tabs into every doc example and the two settings cannot both be satisfied by \
	          editing the examples; the same allow is on veyyon-gui-theme and veyyon-gui-kit"
)]

pub mod agent;
pub mod diff;
pub mod fields;
pub mod files;
pub mod output;
pub mod progress;
pub mod prose;
pub mod question;
pub mod table;
pub mod tone;

mod path;

pub use agent::agent;
pub use diff::diff;
pub use fields::fields;
pub use files::{files, image};
use gpui::{AnyElement, App, IntoElement};
pub use output::{code, invalid, output};
pub use progress::progress;
pub use prose::{markdown, note};
pub use question::question;
pub use table::table;
use veyyon_gui_contract::view::{View, ViewKind};

/// One view part as an element.
///
/// Matches [`View`] with no wildcard arm. A kind added to the contract stops
/// this file compiling, which is the point: a tool result that renders as
/// nothing is a result the operator never sees.
pub fn view(part: &View, cx: &App) -> AnyElement {
	match part {
		View::Fields(value) => fields(value, cx).into_any_element(),
		View::Output(value) => output(value, cx).into_any_element(),
		View::Code(value) => code(value, cx).into_any_element(),
		View::Markdown(value) => markdown(value, cx).into_any_element(),
		View::Note(value) => note(value, cx).into_any_element(),
		View::Table(value) => table(value, cx).into_any_element(),
		View::Files(value) => files(value, cx).into_any_element(),
		View::Image(value) => image(value, cx).into_any_element(),
		View::Diff(value) => diff(value, cx).into_any_element(),
		View::Progress(value) => progress(value, cx).into_any_element(),
		View::Question(value) => question(value, cx).into_any_element(),
		View::Agent(value) => agent(value, cx).into_any_element(),
		View::Invalid(value) => invalid(value, cx).into_any_element(),
	}
}

/// What a part says in one line, for a heading, a collapsed row, or a log.
///
/// This is the same match [`view`] performs, over the same payloads, reduced to
/// data. A gpui element cannot be inspected, so this is what a sweep over
/// [`ViewKind::ALL`] asserts: a kind that returns an empty summary is a kind
/// whose payload the drawing never reaches either.
pub fn summary(part: &View) -> String {
	match part {
		View::Fields(value) => format!("{} fields", value.pairs.len()),
		View::Output(value) => {
			let (lines, hidden) = value.visible();
			format!("{} lines, {hidden} hidden", lines.len())
		},
		View::Code(value) => match &value.language {
			Some(language) => format!("{} lines of {language}", value.text.lines().count()),
			None => format!("{} lines of source", value.text.lines().count()),
		},
		View::Markdown(value) => format!("{} prose blocks", prose::blocks(&value.source).len()),
		View::Note(value) => format!("note: {}", tone::marker(value.tone)),
		View::Table(value) => format!("{} rows in {} columns", value.rows.len(), value.columns.len()),
		View::Files(value) => format!("{} paths, {} omitted", value.entries.len(), value.omitted),
		View::Image(value) => match value.size {
			Some((width, height)) => format!("image {width}×{height}"),
			None => "image, undecoded".to_owned(),
		},
		View::Diff(value) => {
			let (added, removed) = value.totals();
			format!("{} files, +{added} −{removed}", value.files.len())
		},
		View::Progress(value) => match value.fraction() {
			Some(fraction) => format!("{:.0}% of {}", fraction * 100.0, value.label),
			None => format!("{}, indeterminate", value.label),
		},
		View::Question(value) => {
			let state = if value.is_open() { "open" } else { "answered" };
			format!("{} choices, {state}", value.choices.len())
		},
		View::Agent(value) => format!("agent {} {}", value.name, agent::status_label(value)),
		View::Invalid(value) => output::heading(value),
	}
}

/// Which kinds this crate draws, for a caller that wants to check coverage
/// against the contract rather than trust it.
pub fn drawn_kinds() -> Vec<ViewKind> {
	ViewKind::ALL.to_vec()
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The dispatcher is exhaustive, so a kind cannot be forgotten at the match.
	//! What the compiler does not cover is a kind whose arm reaches a payload it
	//! never reads — an arm returning an element built from nothing, which draws
	//! a blank and looks like a tool that returned nothing. [`summary`] performs
	//! the same match over the same payloads, so a kind that cannot describe its
	//! own data cannot draw it either.
	//!
	//! It also pins that no two kinds describe themselves identically, which is
	//! how a copied arm — the defect a 13-arm match invites — is caught.
	//!
	//! WHAT IT DOES NOT CATCH. Appearance. Whether an element is laid out,
	//! coloured or sized correctly needs a window, and the app's capture of
	//! every route is what covers it. It also proves nothing about the
	//! TypeScript side, which has no data model to compare against.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn every_kind_describes_its_own_payload() {
		for kind in ViewKind::ALL {
			let part = fixtures::views::view(kind);
			let text = summary(&part);
			assert!(!text.is_empty(), "{kind:?} described itself as nothing");
			assert_eq!(part.kind(), kind, "the fixture for {kind:?} is another kind");
		}
	}

	#[test]
	fn no_two_kinds_describe_themselves_the_same_way() {
		let mut summaries: Vec<String> = ViewKind::ALL
			.into_iter()
			.map(|kind| summary(&fixtures::views::view(kind)))
			.collect();
		let count = summaries.len();
		summaries.sort();
		summaries.dedup();
		assert_eq!(summaries.len(), count, "two kinds produced the same description");
	}

	#[test]
	fn this_crate_draws_every_kind_the_contract_declares() {
		assert_eq!(drawn_kinds(), ViewKind::ALL.to_vec());
	}

	#[test]
	fn a_summary_reads_the_payload_rather_than_the_kind_name() {
		let one = View::Table(fixtures::views::table());
		let empty = View::Table(veyyon_gui_contract::view::Table::default());
		assert_ne!(summary(&one), summary(&empty), "the summary ignored its payload");
	}
}

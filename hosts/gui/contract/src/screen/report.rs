//! Numbers and rows that are read, not chosen from.
//!
//! The usage report, the rollback release list, the model catalog, the plan
//! review and the keybinding reference are this shape: headline figures, then
//! sections built from view kinds.

use crate::view::{Tone, View};

/// A titled report.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
	pub title:    String,
	/// Headline figures, read left to right before any section.
	pub summary:  Vec<ReportStat>,
	pub sections: Vec<ReportSection>,
	pub footer:   Option<String>,
}

impl Report {
	pub fn new(title: impl Into<String>, sections: Vec<ReportSection>) -> Report {
		Report { title: title.into(), summary: Vec::new(), sections, footer: None }
	}

	pub fn stat(mut self, stat: ReportStat) -> Report {
		self.summary.push(stat);
		self
	}

	pub fn footer(mut self, footer: impl Into<String>) -> Report {
		self.footer = Some(footer.into());
		self
	}
}

/// One headline figure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportStat {
	pub label: String,
	pub value: String,
	pub tone:  Option<Tone>,
}

impl ReportStat {
	pub fn new(label: impl Into<String>, value: impl Into<String>) -> ReportStat {
		ReportStat { label: label.into(), value: value.into(), tone: None }
	}

	pub fn tone(mut self, tone: Tone) -> ReportStat {
		self.tone = Some(tone);
		self
	}
}

/// A heading and the view kinds under it.
///
/// The body is a sequence of view kinds rather than rows of its own, so a
/// section that shows a table shows [`crate::view::Table`] and a section that
/// shows prose shows [`crate::view::Markdown`]. A report has no table model of
/// its own to disagree with the transcript's.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportSection {
	pub heading: Option<String>,
	pub body:    Vec<View>,
	/// What the section has to say when its body is empty.
	pub empty:   Option<String>,
}

impl ReportSection {
	pub fn new(body: Vec<View>) -> ReportSection {
		ReportSection { heading: None, body, empty: None }
	}

	pub fn heading(mut self, heading: impl Into<String>) -> ReportSection {
		self.heading = Some(heading.into());
		self
	}

	pub fn empty_text(mut self, empty: impl Into<String>) -> ReportSection {
		self.empty = Some(empty.into());
		self
	}

	/// Whether every table in the section has rows that match its header.
	///
	/// A report is assembled from several producers — a usage total here, a
	/// per-model breakdown there — and one short row shifts a whole column. The
	/// fixtures assert this across every section, so a shifted table cannot
	/// reach a window through a report that looked fine section by section.
	pub fn is_aligned(&self) -> bool {
		self.body.iter().all(|part| match part {
			View::Table(table) => table.is_aligned(),
			_ => true,
		})
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A report holds view kinds from several producers, and the alignment check
	//! has to reach the tables among them rather than the first part. A section
	//! whose second part is the shifted one is the case a per-section check
	//! passes and a reader sees.
	//!
	//! WHAT IT DOES NOT CATCH. A table nested inside another view kind, which
	//! the vocabulary does not allow today.

	use super::*;
	use crate::view::{Markdown, Table, TableRow};

	#[test]
	fn a_section_reports_a_shifted_table_anywhere_in_its_body() {
		let section = ReportSection::new(vec![
			View::Markdown(Markdown::new("Spend for the current session.")),
			View::Table(Table::new(vec!["model".to_owned(), "cost".to_owned()], vec![TableRow::new(
				vec!["sonnet".to_owned()],
			)])),
		]);
		assert!(!section.is_aligned());
	}

	#[test]
	fn a_section_with_no_table_is_aligned() {
		let section = ReportSection::new(vec![View::Markdown(Markdown::new("Nothing to report."))]);
		assert!(section.is_aligned());
	}
}

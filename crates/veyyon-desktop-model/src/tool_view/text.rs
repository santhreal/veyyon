//! The plain rows a `ToolView` states.
//!
//! A view is drawn as tones, symbols and frames, and none of that is text a
//! reader can copy, search or select. Everything the window does with a block's
//! WORDS reads them from here, so a card that draws a fact also finds and
//! copies it rather than being a hole in the transcript's search.

use super::types::{
	FramedBlockView, HeadedBlockView, NoticeView, StatusRowView, ToolView, ViewHiddenCount,
	ViewLine, ViewSection,
};

/// The words one line states, its runs separated by one space.
///
/// A span with no text carries a symbol the host resolves, so it contributes
/// nothing here and never a doubled separator.
#[must_use]
pub fn line_text(line: &ViewLine) -> String {
	let mut out = String::new();
	for span in line {
		if span.text.is_empty() {
			continue;
		}
		if !out.is_empty() {
			out.push(' ');
		}
		out.push_str(&span.text);
	}
	out
}

/// The words one row states: its title, what it describes, its badge and its
/// trailing facts.
#[must_use]
pub fn row_text(row: &StatusRowView) -> String {
	let mut out = row.title.clone();
	if let Some(description) = &row.description {
		out.push(' ');
		out.push_str(description);
	}
	if let Some(badge) = &row.badge {
		out.push(' ');
		out.push_str(&badge.label);
	}
	for meta in &row.meta {
		let text = line_text(meta);
		if !text.is_empty() {
			out.push(' ');
			out.push_str(&text);
		}
	}
	out
}

/// What a held-back count states, as the row a reader sees under the lines it
/// counts.
fn hidden_row(hidden: Option<&ViewHiddenCount>) -> Option<String> {
	hidden
		.filter(|hidden| hidden.count > 0)
		.map(ViewHiddenCount::format_label)
}

/// The rows one section states: its label, its lines, and what it held back.
fn section_rows(section: &ViewSection, rows: &mut Vec<String>) {
	if let Some(label) = &section.label {
		rows.push(label.clone());
	}
	rows.extend(section.lines.iter().map(line_text));
	rows.extend(hidden_row(section.hidden.as_ref()));
}

fn headed_rows(headed: &HeadedBlockView) -> Vec<String> {
	let mut rows = Vec::new();
	rows.extend(headed.header.as_ref().map(row_text));
	rows.extend(headed.lines.iter().map(line_text));
	rows.extend(hidden_row(headed.hidden.as_ref()));
	rows
}

fn framed_rows(framed: &FramedBlockView) -> Vec<String> {
	let mut rows = Vec::new();
	rows.extend(framed.header.as_ref().map(row_text));
	for section in &framed.sections {
		section_rows(section, &mut rows);
	}
	rows
}

fn notice_rows(notice: &NoticeView) -> Vec<String> {
	let mut headline = line_text(&notice.headline);
	if let Some(tag) = &notice.tag {
		if !headline.is_empty() {
			headline.push(' ');
		}
		headline.push_str(tag);
	}
	let mut rows = vec![headline];
	rows.extend(notice.body.iter().map(line_text));
	rows
}

/// Every row a view states, in the order it draws them.
///
/// Empty rows are dropped: a blank line is spacing the host decided on, and a
/// copied block that carried them would paste the gaps the window drew rather
/// than the words it showed.
#[must_use]
pub fn view_rows(view: &ToolView) -> Vec<String> {
	let rows = match view {
		ToolView::StatusRow(row) => vec![row_text(row)],
		ToolView::TextBlock(text) => line_text(&text.spans).lines().map(str::to_owned).collect(),
		ToolView::HeadedBlock(headed) => headed_rows(headed),
		ToolView::FramedBlock(framed) => framed_rows(framed),
		ToolView::Notice(notice) => notice_rows(notice),
	};
	rows
		.into_iter()
		.filter(|row| !row.trim().is_empty())
		.collect()
}

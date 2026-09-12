//! The one line a collapsed tool card shows (§5.2).
//!
//! A collapsed card is one row of the transcript, and four of the five
//! canonical views are taller than a row: a `headedBlock` carries lines under
//! its header, a `framedBlock` carries sections, a `notice` carries a body, and
//! a `textBlock` carries as many lines as the tool wrote. Rendering one of them
//! inside the row drew the whole block across the rows above and below it,
//! because the row states its height and clipped nothing.
//!
//! This projects any view onto the single line that names it. The expanded card
//! renders the view itself, so nothing is lost: what the row states is what the
//! contract already offers as a one-line summary — a status row, a block's
//! header, a section's label — plus what the card is holding back.

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TokenSet};
use veyyon_desktop_model::tool_view::{
	FramedBlockView, HeadedBlockView, NoticeView, TextBlockView, ToolView, ViewHiddenCount,
	ViewSpan, ViewStatus, ViewTone,
};
use veyyon_gpui::{Div, ParentElement, Styled, div};

use super::{ToolViewCallbacks, status_row::render_status_row, text_block::render_line};

/// Projects a canonical view onto the one line a card's row holds.
///
/// # Arguments
/// * `view` - Borrowed canonical `ToolView` DTO.
/// * `tokens` - Resolved visual design tokens.
/// * `callbacks` - Interaction callbacks for disclosure and target navigation.
/// * `holds_back` - Whether the row states what it left out. False once the
///   card below is showing the view, which holds nothing back.
#[must_use]
pub fn render_tool_view_row(
	view: &ToolView,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
	holds_back: bool,
) -> Div {
	match view {
		// The contract's own one-line shape, which the row renderer already
		// bounds and clips.
		ToolView::StatusRow(row) => render_status_row(row, tokens, callbacks),
		ToolView::TextBlock(text) => text_block_row(text, tokens, callbacks, holds_back),
		ToolView::HeadedBlock(headed) => headed_block_row(headed, tokens, callbacks, holds_back),
		ToolView::FramedBlock(framed) => framed_block_row(framed, tokens, callbacks, holds_back),
		ToolView::Notice(notice) => notice_row(notice, tokens, callbacks, holds_back),
	}
}

/// One clipped line, with what the card holds back stated at its trailing edge.
fn line_row(
	line: &[ViewSpan],
	held_back: Option<String>,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut row = div()
		.flex()
		.flex_row()
		.items_center()
		.w_full()
		.min_w_0()
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.flex_1()
				.min_w_0()
				.child(render_line(line, tokens, callbacks, true)),
		);

	if let Some(label) = held_back {
		row = row.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(label),
		);
	}

	row
}

/// How many lines a card is holding back, in the contract's own wording, and
/// nothing at all once the card is showing them.
fn held_back_lines(count: usize, holds_back: bool) -> Option<String> {
	(holds_back && count > 0)
		.then(|| ViewHiddenCount { count, noun: None, revealable: false }.format_label())
}

/// A text block's first line: the tool's own opening line, up to its first
/// newline, since spans carry newlines the block renderer splits on.
fn text_block_row(
	text: &TextBlockView,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
	holds_back: bool,
) -> Div {
	let mut line: Vec<ViewSpan> = Vec::new();
	let mut rest = 0;

	for span in &text.spans {
		if rest > 0 {
			rest += span.text.matches('\n').count();
			continue;
		}
		match span.text.split_once('\n') {
			Some((head, tail)) => {
				if !head.is_empty() {
					line.push(ViewSpan { text: head.to_owned(), ..span.clone() });
				}
				rest = 1 + tail.matches('\n').count();
			},
			None => line.push(span.clone()),
		}
	}

	line_row(&line, held_back_lines(rest, holds_back), tokens, callbacks)
}

/// A headed block's header, or its first line when it has none.
fn headed_block_row(
	headed: &HeadedBlockView,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
	holds_back: bool,
) -> Div {
	if let Some(header) = &headed.header {
		return render_status_row(header, tokens, callbacks);
	}

	let hidden = headed.hidden.as_ref().map_or(0, |hidden| hidden.count);
	let first = headed.lines.first().map_or(&[][..], Vec::as_slice);
	let rest = headed.lines.len().saturating_sub(1) + hidden;
	line_row(first, held_back_lines(rest, holds_back), tokens, callbacks)
}

/// A framed block's header, or what its first section is called.
fn framed_block_row(
	framed: &FramedBlockView,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
	holds_back: bool,
) -> Div {
	if let Some(header) = &framed.header {
		return render_status_row(header, tokens, callbacks);
	}

	let Some(section) = framed.sections.first() else {
		return line_row(&[], None, tokens, callbacks);
	};

	let hidden = section.hidden.as_ref().map_or(0, |hidden| hidden.count);
	let held: usize = framed
		.sections
		.iter()
		.skip(1)
		.map(|section| section.lines.len())
		.sum();

	if let Some(label) = &section.label {
		let line = [ViewSpan::text(label.clone()).tone(ViewTone::Title)];
		let rest = section.lines.len() + hidden + held;
		return line_row(&line, held_back_lines(rest, holds_back), tokens, callbacks);
	}

	let first = section.lines.first().map_or(&[][..], Vec::as_slice);
	let rest = section.lines.len().saturating_sub(1) + hidden + held;
	line_row(first, held_back_lines(rest, holds_back), tokens, callbacks)
}

/// A notice's mark and headline; its body is what the card holds back.
fn notice_row(
	notice: &NoticeView,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
	holds_back: bool,
) -> Div {
	let mut line: Vec<ViewSpan> = Vec::new();

	if let Some(mark) = &notice.mark {
		line.push(ViewSpan::text(mark.clone()).tone(status_tone(notice.state)));
	}
	line.extend(notice.headline.iter().cloned());

	line_row(&line, held_back_lines(notice.body.len(), holds_back), tokens, callbacks)
}

/// The tone a status carries when it is written as text rather than an icon.
const fn status_tone(status: ViewStatus) -> ViewTone {
	match status {
		ViewStatus::Success | ViewStatus::Done => ViewTone::Success,
		ViewStatus::Error | ViewStatus::Aborted => ViewTone::Error,
		ViewStatus::Warning => ViewTone::Warning,
		ViewStatus::Info => ViewTone::Info,
		ViewStatus::Pending | ViewStatus::Running => ViewTone::Accent,
	}
}

//! The layer a detail popover is drawn in (§5.6, §8.25).
//!
//! The popover holds the window's focus while it is drawn, so the keystrokes
//! the surface under it would answer -- a character the composer would take
//! into the draft, a chord the transcript would scroll by -- do not reach it.
//! Dismissing it gives the focus back to whatever held it when it opened,
//! which is what the shell records beside the popover itself.
//!
//! There is no scrim. A detail is anchored to the control it belongs to and
//! covers a card's worth of the window, so a press outside it is a press on
//! the surface it is floating over, which is reported through the popover's
//! own rect rather than through a full-window rect that would swallow it.

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, MonoText, Popover, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_motion::FloatFrame;
use veyyon_gpui::{Context, FocusHandle, IntoElement, ParentElement, Pixels, Size, Styled, div};

use super::{Detail, DetailFacts, DetailRow};
use crate::ShellView;

/// Draws the detail popover for `detail`, stating `facts`.
pub fn detail_layer(
	detail: &Detail,
	facts: &DetailFacts,
	frame: FloatFrame,
	focus: &FocusHandle,
	size: Size<Pixels>,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut body = div()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(facts.heading.clone()),
		);
	for row in &facts.rows {
		body = body.child(fact_row(row, tokens));
	}
	let entity = cx.weak_entity();
	Popover::new(detail.origin, detail.anchor, body)
		.id("detail-popover")
		.size(size)
		.entrance(frame)
		.focus(focus)
		.on_dismiss(move |window, app| {
			let Some(entity) = entity.upgrade() else {
				return;
			};
			entity.update(app, |view, cx| {
				view.close_detail(window, cx);
				cx.notify();
			});
		})
}

/// One fact: its name, then its value on the line under it.
///
/// The value is the whole reason the popover is open, so it wraps rather than
/// truncating: a path cut here would be cut exactly where the row that could
/// not draw it cut it.
fn fact_row(row: &DetailRow, tokens: &TokenSet) -> impl IntoElement {
	div()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(row.label),
		)
		.child(
			div()
				.min_w_0()
				.mono_text(tokens, MonoSizeStep::Small)
				.text_color(tokens.color(ColorRole::Secondary))
				.child(row.value.clone()),
		)
}

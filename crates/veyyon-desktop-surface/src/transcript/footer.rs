//! The footer under an agent turn: which model produced it, and the way to
//! what it cost (§5.3).
//!
//! `EntryMeta.usage` has seven fields. Put them in the turn header and every
//! turn carries a row of figures that is read once and skipped forever after,
//! so the header states nothing about them. The footer names the model at 12px
//! muted, revealed when the pointer is over the turn or the keyboard is on it,
//! and a click on that name opens the accounting on one line in the right
//! panel's usage tab.

use veyyon_desktop_kit::{ColorRole, TextRamp, TokenSet};
use veyyon_gpui::{
	App, Div, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, WeakEntity, div,
};

use crate::{Intent, ShellView};

/// The hover group a turn establishes so its footer can reveal with it.
pub const TURN_FOOTER_GROUP: &str = "transcript-turn-footer";

/// Renders the footer row for one agent turn.
///
/// # Arguments
/// * `turn_ix` - Index of the turn in the transcript, for the element id.
/// * `model` - The model the host reported for this turn.
/// * `is_focused` - Whether the keyboard is on this turn, which reveals the
///   name the way hovering it does: an operator driving from the keyboard has
///   no other way to read which model answered.
/// * `tokens` - The resolved token set.
/// * `view` - The shell the click dispatches through, absent in projections
///   rendered without a window.
#[must_use]
pub fn render_turn_footer(
	turn_ix: usize,
	model: &str,
	is_focused: bool,
	tokens: &TokenSet,
	view: Option<&WeakEntity<ShellView>>,
) -> Div {
	let mut name = div()
		.id(("transcript-turn-footer", turn_ix))
		.opacity(if is_focused { 1.0 } else { 0.0 })
		.group_hover(TURN_FOOTER_GROUP, |style| style.opacity(1.0))
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small))
		.text_color(tokens.color(ColorRole::Muted))
		.hover(|style| style.text_color(tokens.color(ColorRole::Secondary)))
		.whitespace_nowrap()
		.child(model.to_owned());

	if let Some(weak) = view.cloned() {
		name = name.on_click(move |_event, _window, app: &mut App| {
			app.stop_propagation();
			let _ = weak.update(app, |shell, cx| shell.dispatch(Intent::OpenUsage, cx));
		});
	}

	div().w_full().flex().flex_row().items_center().child(name)
}

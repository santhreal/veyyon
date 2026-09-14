//! The row that states what a view is holding back, and reveals it.
//!
//! A headed block and a framed section both end with this row, and both used
//! to carry their own copy of it. The label is host text — `ViewHiddenCount`
//! carries the noun the tool chose — so a copy that gives it no width role
//! draws it past the block, and fixing one copy left the other wrong.

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, MouseButton, ParentElement, Styled, div, px,
};

use super::{ToolViewCallbacks, fit::FitsTheRow};

/// Renders the disclosure row for `label`.
///
/// Reveals on click when the host marked the hidden count `revealable` and a
/// disclosure callback is registered; otherwise it states the count and
/// nothing more, so a row that cannot be opened is not drawn as if it could.
#[must_use]
pub fn render_disclosure(
	label: &str,
	revealable: bool,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let Some(on_disclose) = callbacks.on_disclose.clone().filter(|_| revealable) else {
		return div()
			.flex()
			.flex_row()
			.items_center()
			.min_w_0()
			.overflow_hidden()
			.mt(tokens.spacing(SpacingStep::S1))
			.child(
				div()
					.fit_primary()
					.text_size(tokens.font_size(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("({label})")),
			);
	};

	div()
		.flex()
		.flex_row()
		.items_center()
		.min_w_0()
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S1))
		.mt(tokens.spacing(SpacingStep::S1))
		.px(tokens.spacing(SpacingStep::S2))
		.py(px(2.0))
		.rounded(tokens.radius(RadiusStep::Sm))
		.bg(tokens.color(ColorRole::Inset))
		.cursor(CursorStyle::PointingHand)
		.hover(|style| style.bg(tokens.color(ColorRole::Canvas)))
		.on_mouse_down(MouseButton::Left, move |_event, window, cx| {
			on_disclose(window, cx);
		})
		.child(
			Icon::new(IconName::ChevronRight)
				.size(IconSize::Size12)
				.color(tokens.color(ColorRole::Accent)),
		)
		.child(
			div()
				.fit_primary()
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Accent))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.child(label.to_string()),
		)
}

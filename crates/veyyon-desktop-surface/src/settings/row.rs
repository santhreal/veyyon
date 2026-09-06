//! The single unified settings row shape (§5.9).
//!
//! Every settings page renders its controls through `setting_row`: a 44px row
//! with a 14/20 label, an optional 12/16 muted description, and a 240px
//! right-aligned control column. Control availability gates opacity and
//! activation.

use veyyon_desktop_kit::{
	ColorRole, Row, Spacer, SpacingStep, Stack, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Div, IntoElement, ParentElement, Styled, div, px};

use crate::controls::Availability;

/// Renders a single 44px settings row adhering to the unified §5.9
/// specification.
pub fn setting_row(
	label: &str,
	description: Option<&str>,
	control: impl IntoElement,
	availability: &Availability,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	setting_row_with_secondary(
		label,
		description,
		control,
		None::<veyyon_gpui::AnyElement>,
		availability,
		geometry,
		tokens,
	)
}

/// Renders a single 44px settings row with an optional secondary trailing
/// control.
pub fn setting_row_with_secondary(
	label: &str,
	description: Option<&str>,
	control: impl IntoElement,
	secondary: Option<impl IntoElement>,
	availability: &Availability,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let is_available = matches!(availability, Availability::Enabled | Availability::Unknown);
	let is_pending = matches!(availability, Availability::Pending);
	let opacity = if is_available {
		1.0
	} else if is_pending {
		0.6
	} else {
		0.45
	};

	let label_color = if is_available {
		tokens.color(ColorRole::Foreground)
	} else {
		tokens.color(ColorRole::Muted)
	};

	let label_el = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(px(20.0))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(label_color)
		.child(label.to_string());

	let desc_el = description.map(|desc| {
		div()
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(px(16.0))
			.text_color(tokens.color(ColorRole::Muted))
			.child(desc.to_string())
	});

	// The label and its description stack with no gap: the two line heights
	// are the row's rhythm. The column around the stack takes the width the
	// control column leaves, and centres the stack in the row's height.
	let left_col = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_col()
		.justify_center()
		.child(
			Stack::vertical(SpacingStep::S0)
				.child(label_el)
				.children(desc_el),
		);

	// The secondary control, when there is one, sits before the control in
	// one row; the column around the row pins its width and aligns it to the
	// trailing edge.
	let right_col = div()
		.w(px(geometry.control_column_width_px))
		.flex_shrink_0()
		.flex()
		.flex_row()
		.justify_end()
		.child(Row::new(SpacingStep::S2).children(secondary).child(control));

	div()
		.h(px(geometry.row_height_px))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.opacity(opacity)
		.child(left_col)
		.child(Spacer::new(SpacingStep::S4))
		.child(right_col)
}

/// Renders an empty-state message row spanning the full row width with muted
/// typography.
pub fn empty_state_row(message: &str, geometry: &SettingsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.h(px(geometry.row_height_px))
		.w_full()
		.flex()
		.items_center()
		.justify_start()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(px(20.0))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_string())
}

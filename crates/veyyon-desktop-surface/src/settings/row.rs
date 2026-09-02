//! The single unified settings row shape (§5.9).
//!
//! Every settings page renders its controls through `setting_row`: a 44px row
//! with a 14/20 label, an optional 12/16 muted description, and a 240px
//! right-aligned control column. Control availability gates opacity and
//! activation.

use veyyon_desktop_kit::{ColorRole, TextRamp, TextWeight, TokenSet};
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

	let mut left_col = div().flex_1().min_w_0().flex().flex_col().justify_center();

	let label_el = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(px(20.0))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(label_color)
		.child(label.to_string());
	left_col = left_col.child(label_el);

	if let Some(desc) = description {
		let desc_el = div()
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(px(16.0))
			.text_color(tokens.color(ColorRole::Muted))
			.child(desc.to_string());
		left_col = left_col.child(desc_el);
	}

	let mut right_col = div()
		.w(px(geometry.control_column_width_px))
		.flex_shrink_0()
		.flex()
		.flex_row()
		.justify_end()
		.items_center()
		.gap(tokens.spacing(veyyon_desktop_kit::SpacingStep::S2));

	if let Some(sec) = secondary {
		right_col = right_col.child(sec);
	}
	right_col = right_col.child(control);

	div()
		.h(px(geometry.row_height_px))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.opacity(opacity)
		.child(left_col)
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

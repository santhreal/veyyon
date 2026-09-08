//! The single unified settings row shape (§5.9).
//!
//! Every settings page renders its controls through `setting_row`: a row of
//! exactly 44px, with a 14/20 label, an optional 12/16 muted description,
//! and a 240px right-aligned control column. Control availability gates opacity
//! and activation.

use veyyon_desktop_kit::{
	ColorRole, Spacer, SpacingStep, Stack, TextRamp, TextWeight, TokenSet, overlays::Tooltip,
};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Div, IntoElement, ParentElement, Styled, div, px};

use crate::controls::Availability;

/// Renders a settings row with the unified §5.9 minimum height.
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

/// Renders a settings row with an optional secondary trailing control.
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
		.w_full()
		.min_w_0()
		.overflow_hidden()
		.whitespace_nowrap()
		.truncate()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(px(20.0))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(label_color)
		.child(one_line(label));

	// The row is its declared height, so a description is the one 16px line
	// under the label and the rest of the sentence is read on hover. A
	// description that wrapped grew the row to the length of its prose, which
	// is what turned a page of settings into a column of paragraphs.
	let desc_el = description.map(|desc| {
		div()
			.w_full()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(px(16.0))
			.text_color(tokens.color(ColorRole::Muted))
			.child(one_line(desc))
	});

	// The label and its description stack with no gap: the two line heights
	// are the row's rhythm. The column around the stack takes the width the
	// control column leaves, and centres the stack in the row's height.
	let stack = Stack::vertical(SpacingStep::S0)
		.child(label_el)
		.children(desc_el);
	let left_col = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_col()
		.justify_center()
		.child(match description {
			Some(desc) => Tooltip::new(desc.to_owned(), stack)
				.keyed(format!("setting-row:{label}"))
				.wrapping(px(geometry.tooltip_width_px))
				.into_any_element(),
			None => stack.into_any_element(),
		});

	// The secondary control, when there is one, sits before the control in
	// one row; the column around the row pins its width and aligns it to the
	// trailing edge. The control takes what the secondary leaves, so a field
	// that asks for its parent's width draws the column's width rather than
	// collapsing to its own padding, and a control sized by its content
	// stays on the trailing edge.
	let right_col = div()
		.w(px(geometry.control_column_width_px))
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_end()
		.gap(tokens.spacing(SpacingStep::S2))
		.children(secondary)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.flex()
				.flex_row()
				.items_center()
				.justify_end()
				.child(control),
		);

	// The row clips to its own band: a control or a description that asks for
	// more room than the row declares is cut at the row's edge rather than
	// painted over the row under it.
	div()
		.h(px(geometry.row_height_px))
		.flex_shrink_0()
		.overflow_hidden()
		.py(tokens.spacing(SpacingStep::S1))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.opacity(opacity)
		.child(left_col)
		.child(Spacer::new(SpacingStep::S4))
		.child(right_col)
}

/// Collapses every run of whitespace, including the newlines a host writes
/// into a description, into one space: a row states one line, and a break in
/// the prose would draw a second one over the row underneath.
fn one_line(text: &str) -> String {
	text.split_whitespace().collect::<Vec<&str>>().join(" ")
}

/// Renders an empty-state message row spanning the full row width with muted
/// typography.
pub fn empty_state_row(message: &str, geometry: &SettingsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.h(px(geometry.row_height_px))
		.flex_shrink_0()
		.w_full()
		.flex()
		.items_center()
		.justify_start()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(px(20.0))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_string())
}

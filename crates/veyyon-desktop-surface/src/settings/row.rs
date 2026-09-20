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

	let label_tracking = px(geometry.label_size.tracking_em * geometry.label_size.size);
	let label_el = div()
		.w_full()
		.min_w_0()
		.overflow_hidden()
		.whitespace_nowrap()
		.truncate()
		.text_size(px(geometry.label_size.size))
		.line_height(px(geometry.label_size.line_height))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(label_color)
		.tracking(label_tracking)
		.child(one_line(label));
	// The row is its declared height, so a description is the one 16px line
	// under the label and the rest of the sentence is read on hover. A
	// description that wrapped grew the row to the length of its prose, which
	// is what turned a page of settings into a column of paragraphs.
	let desc_tracking = px(geometry.description_size.tracking_em * geometry.description_size.size);
	let desc_el = description.map(|desc| {
		div()
			.w_full()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(px(geometry.description_size.size))
			.line_height(px(geometry.description_size.line_height))
			.text_color(tokens.color(ColorRole::Muted))
			.tracking(desc_tracking)
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

/// Renders the settings body's empty state, stating the condition and the
/// corrective action, with the same two-part presentation as `crate::empty`.
///
/// This leaves the row grid rather than sitting on it. A row's declared height
/// is measured for one line, and the two lines here overflow it by 4px, which
/// clips the descenders of the action. An empty state is the whole body when
/// the list is empty, not a row among rows, so it takes its height from its
/// content and centres in the space the rows would have filled.
pub fn empty_state_row(
	condition: &str,
	action: &str,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	div()
		.w_full()
		.flex_1()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.py(px(geometry.row_height_px))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(condition.to_string()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(action.to_string()),
		)
}

/// Shortens a filesystem path for display: collapses home directory to `~`
/// and intermediate directories if the path is long, matching `shortenPath`.
#[must_use]
pub fn shorten_path(raw: &str) -> String {
	let path = raw.replace('\\', "/");
	let shortened = if let Ok(home) = std::env::var("HOME") {
		let home_norm = home.replace('\\', "/");
		if path.starts_with(&home_norm) {
			format!("~{}", &path[home_norm.len()..])
		} else {
			path
		}
	} else if let Some(stripped) = path
		.strip_prefix("/home/")
		.or_else(|| path.strip_prefix("/Users/"))
	{
		if let Some(pos) = stripped.find('/') {
			format!("~{}", &stripped[pos..])
		} else {
			path
		}
	} else {
		path
	};

	if shortened.len() > 36 {
		let parts: Vec<&str> = shortened.split('/').filter(|p| !p.is_empty()).collect();
		if parts.len() > 2 {
			let first = parts[0];
			let last = parts[parts.len() - 1];
			format!("{first}/…/{last}")
		} else {
			shortened
		}
	} else {
		shortened
	}
}

/// Renders a settings group header row (§5.9, §6.4).
pub fn group_header_row(
	title: &str,
	is_first: bool,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let pt = if is_first {
		px(0.0)
	} else {
		px(geometry.group_gap)
	};
	div()
		.h(tokens.spacing(SpacingStep::S9))
		.pt(pt)
		.pb(tokens.spacing(SpacingStep::S2))
		.flex()
		.items_center()
		.text_size(tokens.font_size(TextRamp::Small))
		.font_weight(tokens.font_weight(TextWeight::Semibold))
		.text_color(tokens.color(ColorRole::Muted))
		.child(title.to_uppercase())
}

//! Rendering of individual diff rows and hunk headers (§5.11).

use std::ops::Range;

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, MonoText, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{ShellView, intent::Intent, right_panel::content::DiffWithheld};

/// A line-number control retains the source side even when split rows are
/// paired.
pub fn review_line_cell(
	cell: Div,
	enabled: bool,
	path: &str,
	side: veyyon_desktop_model::review::ReviewSide,
	line: Option<usize>,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	if !enabled {
		return cell;
	}
	let Some(line) = line else {
		return cell;
	};
	let path = path.to_owned();
	cell
		.cursor_pointer()
		.hover(|style| style.bg(tokens.row_hover()))
		.on_mouse_down(
			veyyon_gpui::MouseButton::Left,
			cx.listener(move |view, event: &veyyon_gpui::MouseDownEvent, window, cx| {
				if view.open_review_line(&path, side, line, event.position, window, cx) {
					cx.stop_propagation();
				}
			}),
		)
}

/// The text a hunk header states: its ranges, and the symbol it sits in when
/// the host named one.
///
/// Stated here rather than only inside the header's own element because the
/// pane it draws in has to be at least as wide as the header (§5.11), and the
/// pane's width is counted in cells before any of it is drawn.
#[must_use]
pub fn hunk_header_text(
	old_start: usize,
	old_count: usize,
	new_start: usize,
	new_count: usize,
	symbol: &Option<String>,
) -> String {
	let ranges = format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@");
	match symbol {
		Some(symbol) => format!("{ranges} {symbol}"),
		None => ranges,
	}
}

/// Renders a hunk header boundary bar (§5.11).
pub fn render_hunk_header(
	old_start: usize,
	old_count: usize,
	new_start: usize,
	new_count: usize,
	symbol: &Option<String>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let range_text = format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@");
	let mut el = div()
		.h(px(geometry.diff_hunk_header_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.px(tokens.spacing(SpacingStep::S3))
		.bg(tokens.color(ColorRole::Inset))
		.mono_text(tokens, MonoSizeStep::Small)
		.line_height(px(geometry.diff_hunk_header_height_px))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::Secondary))
		.child(range_text);

	if let Some(sym) = symbol {
		el = el.child(
			div()
				.text_color(tokens.color(ColorRole::Foreground))
				.truncate()
				.child(sym.clone()),
		);
	}

	el
}

/// Renders a gutter cell containing a line number.
pub fn gutter_cell(text: &str, geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.w(px(geometry.diff_gutter_width_px))
		.flex_shrink_0()
		.text_align(veyyon_gpui::TextAlign::Right)
		.pr(tokens.spacing(SpacingStep::S2))
		.text_color(tokens.color(ColorRole::Secondary))
		.child(text.to_string())
}

/// Renders a sign cell (+, -, or space).
pub fn sign_cell(
	sign: &str,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	color: ColorRole,
) -> Div {
	div()
		.w(px(geometry.diff_sign_width_px))
		.flex_shrink_0()
		.text_align(veyyon_gpui::TextAlign::Center)
		.text_color(tokens.color(color))
		.child(sign.to_string())
}

/// Renders line content with intraline highlight spans.
pub fn content_cell(
	text: &str,
	intraline: &[Range<usize>],
	tokens: &TokenSet,
	highlight_bg: Option<veyyon_gpui::Hsla>,
) -> Div {
	let mut container = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_row()
		.items_center()
		.overflow_hidden()
		.whitespace_nowrap()
		.text_color(tokens.color(ColorRole::Foreground));

	if intraline.is_empty() || highlight_bg.is_none() {
		return container.child(text.to_string());
	}

	let hl = highlight_bg.expect("checked above");
	let mut cursor = 0;

	for span in intraline {
		if span.start > cursor
			&& span.start <= text.len()
			&& text.is_char_boundary(cursor)
			&& text.is_char_boundary(span.start)
		{
			container = container.child(text[cursor..span.start].to_string());
		}
		if span.end <= text.len()
			&& span.start < span.end
			&& text.is_char_boundary(span.start)
			&& text.is_char_boundary(span.end)
		{
			container = container.child(
				div()
					.bg(hl)
					.rounded(tokens.radius(RadiusStep::Xs))
					.child(text[span.start..span.end].to_string()),
			);
			cursor = span.end;
		}
	}

	if cursor < text.len() && text.is_char_boundary(cursor) {
		container = container.child(text[cursor..].to_string());
	}
	container
}

/// Renders a collapsed context region offering in-place expansion.
pub fn render_collapsed_row(
	file_index: usize,
	row_index: usize,
	hidden: usize,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.id(veyyon_gpui::ElementId::Name(format!("collapsed-row-{file_index}-{row_index}").into()))
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::ExpandContext { file: file_index, row: row_index }, cx);
		}))
		.h(px(geometry.diff_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_center()
		.bg(tokens.color(ColorRole::Inset))
		.hover(|s| s.bg(tokens.row_hover()))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Secondary))
		.child(collapsed_label(hidden))
}

/// What a collapsed region's row reads.
///
/// Stated here rather than inside the row, because the pane's content width is
/// measured from the same text and a second copy of it would drift from this
/// one, which shows as a row of the diff standing wider than the extent the
/// pane can scroll to.
pub fn collapsed_label(hidden: usize) -> String {
	format!("Expand {hidden} lines")
}

/// What the row at the changed-line cap reads.
pub fn truncated_notice(remaining: usize) -> String {
	format!("2,000 changed lines cap reached ({remaining} more lines not shown)")
}

/// What the pane states when the host cut the snapshot these rows came from,
/// one line per fact, empty when the host sent the scope whole.
///
/// One line per fact rather than one sentence carrying both: the pane is
/// narrower than the two facts joined, so a single line ellipsises the second
/// away in the state that has most to say.
///
/// The size is the one the window received rather than the host's budget: two
/// copies of a budget drift, and the bytes in hand are the honest figure.
#[must_use]
pub fn withheld_notices(withheld: DiffWithheld) -> Vec<String> {
	let mut lines = Vec::new();
	if withheld.diff_truncated {
		let sent = bytes_label(withheld.diff_bytes);
		lines.push(format!("This host sent the first {sent} of this diff"));
	}
	if withheld.files_withheld > 0 {
		let files = withheld.files_withheld;
		lines.push(format!("{files} more changed files are not listed"));
	}
	lines
}

/// A byte count to one decimal place, in the unit a reader of a diff thinks
/// in. Integer arithmetic: a float conversion of a size loses precision the
/// lint catches and buys nothing at one decimal.
fn bytes_label(bytes: usize) -> String {
	const MIB: usize = 1024 * 1024;
	const KIB: usize = 1024;
	let (tenths, unit) = if bytes >= MIB {
		(bytes * 10 / MIB, "MiB")
	} else {
		(bytes * 10 / KIB, "KiB")
	};
	format!("{}.{} {unit}", tenths / 10, tenths % 10)
}

/// Renders a notice row for binary/unavailable files or truncation.
pub fn render_notice_row(message: &str, geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.h(px(geometry.diff_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.px(tokens.spacing(SpacingStep::S3))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_string())
}

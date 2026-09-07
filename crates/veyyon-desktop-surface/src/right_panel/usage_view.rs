//! The right panel's usage tab: the session's accounting on one line (§5.3).
//!
//! `EntryMeta.usage` has seven fields and none of them belongs in a turn
//! header, where they would be read once and then read past on every turn
//! after. They sit here instead, on one row of tabular figures, reached from
//! the turn footer that names the model.

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TokenSet};
use veyyon_desktop_model::UsageTotals;
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Div, InteractiveElement, ParentElement, Stateful, StatefulInteractiveElement, Styled, div, px,
};

/// Groups the digits of a count so two rows of figures can be compared.
#[must_use]
fn grouped(count: u64) -> String {
	let digits = count.to_string();
	let mut out = String::with_capacity(digits.len() + digits.len() / 3);
	let len = digits.len();
	for (index, digit) in digits.chars().enumerate() {
		if index > 0 && (len - index).is_multiple_of(3) {
			out.push(',');
		}
		out.push(digit);
	}
	out
}

/// The seven fields, in the order they are read: what went in, what came back,
/// what was reused, what it was charged as, and what it cost.
#[must_use]
fn cells(totals: &UsageTotals) -> Vec<(&'static str, String)> {
	vec![
		("In", grouped(totals.input_tokens)),
		("Out", grouped(totals.output_tokens)),
		("Cache read", grouped(totals.cache_read_tokens)),
		("Cache write", grouped(totals.cache_write_tokens)),
		("Orchestration", grouped(totals.orchestration_tokens)),
		("Premium", grouped(u64::from(totals.premium_requests))),
		(
			"Cost",
			totals
				.cost_microusd
				.map_or_else(|| "—".to_owned(), |micro| format!("${:.4}", micro as f64 / 1_000_000.0)),
		),
	]
}

/// Builds the usage tab's body.
///
/// # Arguments
/// * `totals` - The accounting the host reported for the open session.
/// * `geometry` - The panel's resolved geometry.
/// * `tokens` - The resolved token set.
#[must_use]
pub fn usage_view(
	totals: Option<&UsageTotals>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> Stateful<Div> {
	let row = div()
		.id("panel-usage")
		.w_full()
		.flex_shrink_0()
		.h(px(geometry.chrome_row_height_px))
		.px(tokens.spacing(SpacingStep::S3))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S5))
		.border_b(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.whitespace_nowrap();

	let Some(totals) = totals else {
		return row.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("No accounting reported for this session yet."),
		);
	};

	// The row scrolls rather than shedding a field: a count that is not on
	// screen is one the operator cannot check, and hiding it silently is worse
	// than making them scroll for it.
	let mut row = row.overflow_x_scroll();
	for (label, value) in cells(totals) {
		row = row.child(
			div()
				.flex_shrink_0()
				.flex()
				.flex_row()
				.items_baseline()
				.gap(tokens.spacing(SpacingStep::S1))
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(tokens.line_height(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Muted))
						.child(label),
				)
				.child(
					div()
						.font_family(tokens.mono_family())
						.text_size(tokens.font_size(TextRamp::Small))
						.line_height(tokens.line_height(TextRamp::Small))
						.text_color(tokens.color(ColorRole::Foreground))
						.child(value),
				),
		);
	}
	row
}

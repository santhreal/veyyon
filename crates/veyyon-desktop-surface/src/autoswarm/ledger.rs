//! The run ledger: one row per logged experiment, newest first (§5.8).
//!
//! A run's label, metric, delta and outcome arrive formatted from the console
//! model, so the ledger drawn here and the card the terminal draws cannot
//! disagree about what a run measured.

use veyyon_desktop_kit::{Badge, ColorRole, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet};
use veyyon_desktop_model::{AutoswarmConsoleView, AutoswarmRunView};
use veyyon_desktop_tokens::AutoswarmSurfaceTokens;
use veyyon_gpui::{
	AnyElement, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
	div, px,
};

/// The ledger: its heading, one row per run, and the line a swarm with no run
/// logged states in place of an empty column.
pub fn ledger_section(
	console: &AutoswarmConsoleView,
	geometry: &AutoswarmSurfaceTokens,
	tokens: &TokenSet,
) -> AnyElement {
	let heading = div()
		.text_size(tokens.font_size(TextRamp::Body))
		.line_height(tokens.line_height(TextRamp::Body))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::Foreground))
		.child("Runs");

	if console.runs.is_empty() {
		return div()
			.id("autoswarm-ledger")
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(heading)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child("No run has been logged. Start the swarm to measure one."),
			)
			.into_any_element();
	}

	let mut list = div()
		.id("autoswarm-ledger-list")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.overflow_y_scroll()
		.flex_1();

	for (index, run) in console.runs.iter().enumerate() {
		list = list.child(run_row(index, run, geometry, tokens));
	}

	div()
		.id("autoswarm-ledger")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.flex_1()
		.child(heading)
		.child(list)
		.into_any_element()
}

/// One run: what it is, what it measured, and how that compares with the
/// baseline of its own segment.
fn run_row(
	index: usize,
	run: &AutoswarmRunView,
	geometry: &AutoswarmSurfaceTokens,
	tokens: &TokenSet,
) -> AnyElement {
	let mut heading = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(run.label.clone()),
		);

	if let Some(arm) = run.arm.as_ref() {
		heading = heading.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(arm.clone()),
		);
	}

	if run.best {
		heading = heading.child(Badge::new("best", TintRole::Done));
	}

	let mut measure = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small))
		.child(
			div()
				.text_color(tokens.color(ColorRole::Foreground))
				.child(run.metric.clone()),
		)
		.child(
			div()
				.text_color(tokens.color(ColorRole::Muted))
				.child(run.outcome.clone()),
		);

	if let Some(delta) = run.delta.as_ref() {
		measure = measure.child(
			div()
				.text_color(tokens.color(ColorRole::Muted))
				.child(delta.clone()),
		);
	}

	let mut row = div()
		.id(("autoswarm-run", index))
		.flex()
		.flex_col()
		.justify_center()
		.h(px(geometry.ledger_row_height_px))
		.child(heading)
		.child(measure);

	for (line, detail) in run.detail.iter().enumerate() {
		row = row.child(
			div()
				.id(("autoswarm-run-detail", index * 100 + line))
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(detail.clone()),
		);
	}

	row.into_any_element()
}

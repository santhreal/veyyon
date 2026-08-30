//! How far through a long operation is.

use gpui::{App, Div, ParentElement, SharedString, Styled};
use veyyon_gui_contract::view::Progress;
use veyyon_gui_kit::{
	Level,
	chrome::{column, row},
	surface,
	text::text_in,
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_motion::{AnimationExt, WORKING_PULSE, phase};
use veyyon_gui_theme::Role;

/// The bar's height and the width it reserves.
const BAR: (f32, f32) = (4.0, 240.0);

/// How wide the moving segment of an indeterminate bar is, as a fraction.
const SWEEP: f32 = 0.3;

pub fn progress(value: &Progress, cx: &App) -> Div {
	let mut heading = row(space::SNUG).items_baseline().child(text_in(
		value.label.clone(),
		Role::TextPrimary,
		text::BODY,
		cx,
	));
	if let Some(readout) = readout(value) {
		heading = heading.child(text_in(readout, Role::TextSecondary, text::SMALL, cx));
	}

	let mut stack = column(space::TIGHT).child(heading).child(bar(value, cx));
	if let Some(current) = &value.current {
		stack = stack.child(text_in(current.clone(), Role::TextMuted, text::SMALL, cx));
	}
	stack
}

/// The track, with either a filled segment or a moving one.
fn bar(value: &Progress, cx: &App) -> Div {
	let track = surface(Level::Sunken, cx)
		.w(gpui::px(BAR.1))
		.h(gpui::px(BAR.0))
		.rounded(radius::SMALL)
		.overflow_hidden();
	let fill = gpui::div()
		.h_full()
		.rounded(radius::SMALL)
		.bg(cx.color(Role::TextAccent));

	match value.fraction() {
		Some(fraction) => track.child(fill.w(gpui::relative(fraction))),
		None => track.child(fill.w(gpui::relative(SWEEP)).with_animation(
			SharedString::from("progress-sweep"),
			WORKING_PULSE.repeating(),
			|element, t| element.left(gpui::relative(sweep_offset(t))),
		)),
	}
}

/// Where the moving segment sits at animation position `t`.
///
/// The segment travels across the track and back rather than wrapping, so it
/// never leaves the track partway through and reappears at the other edge.
/// `phase::triangle` is the same shape the working indicator uses.
pub fn sweep_offset(t: f32) -> f32 {
	phase::triangle(t) * (1.0 - SWEEP)
}

/// What the heading says beside the label.
///
/// A determinate operation reports its counts and its percentage; an
/// indeterminate one reports the count it has, because a percentage it does not
/// have is the number an operator would otherwise read as stalled.
pub fn readout(value: &Progress) -> Option<String> {
	match (value.total, value.fraction()) {
		(Some(total), Some(fraction)) => {
			Some(format!("{}/{total} · {:.0}%", value.done, fraction * 100.0))
		},
		_ if value.done > 0 => Some(value.done.to_string()),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A bar is drawn from a fraction the producer controls both sides of. The
	//! contract clamps the fraction; what is left here is the readout, which
	//! reports a percentage an indeterminate operation does not have, and the
	//! sweep offset, which is what keeps the moving segment inside its track. An
	//! offset that reaches 1.0 puts the segment entirely outside the track, and
	//! the bar reads as finished and empty.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the animation runs. That needs a window.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_determinate_operation_reports_its_counts_and_percentage() {
		assert_eq!(readout(&fixtures::views::progress()), Some("148/412 · 36%".to_owned()));
	}

	#[test]
	fn an_indeterminate_operation_reports_a_count_and_no_percentage() {
		let readout = readout(&fixtures::views::indeterminate_progress())
			.expect("an indeterminate operation with work done reports it");
		assert_eq!(readout, "9");
		assert!(!readout.contains('%'));
	}

	#[test]
	fn an_operation_that_has_done_nothing_reports_nothing() {
		assert_eq!(readout(&Progress::new("Waiting", 0)), None);
	}

	#[test]
	fn a_zero_total_reports_a_count_rather_than_dividing() {
		assert_eq!(readout(&Progress::new("Indexing", 4).total(0)), Some("4".to_owned()));
	}

	#[test]
	fn the_moving_segment_never_leaves_its_track() {
		const STEPS: u32 = 40;
		for step in 0..=STEPS {
			let t = f32::from(u16::try_from(step).expect("the step count fits")) / STEPS as f32;
			let offset = sweep_offset(t);
			assert!((0.0..=1.0 - SWEEP).contains(&offset), "the segment left the track at t={t}");
		}
	}
}

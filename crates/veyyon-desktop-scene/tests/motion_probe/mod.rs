//! What the motion roles produce, sampled rather than drawn.
//!
//! A still frame shows no animation, so a frame comparison cannot see a
//! stiffness or a duration. Each role is driven through its own animator from
//! a fixed start instant and sampled at a fixed series of offsets, and the
//! series is the observation: doubling any parameter of a role changes the
//! trajectory it reports.

use std::{fmt::Write, time::Duration};

use veyyon_desktop_motion::{
	CaretMotion, FloatMotion, PanelMotion, RevealMotion, ScrollMotion, ShiftMotion, TintMotion,
};
use veyyon_desktop_scene::Headless;
use veyyon_desktop_tokens::Tokens;
use veyyon_gpui::motion::{FrameInstant, MotionPolicy, MotionTokens};

use crate::dead_token_probe::Observation;

/// The render context's clock, read at offsets from the instant a series
/// starts.
struct Series<'a> {
	cx:      &'a mut Headless,
	elapsed: Duration,
}

impl<'a> Series<'a> {
	/// A series starting at the clock's current instant.
	const fn start(cx: &'a mut Headless) -> Self {
		Self { cx, elapsed: Duration::ZERO }
	}

	/// The instant `ms` milliseconds after the series started. Time only moves
	/// forward.
	fn at(&mut self, ms: u64) -> FrameInstant {
		let target = Duration::from_millis(ms);
		let step = target
			.checked_sub(self.elapsed)
			.unwrap_or_else(|| panic!("the series does not move back to {ms} ms"));
		self.cx.advance_clock(step);
		self.elapsed = target;
		self.cx.update(|app| app.frame_instant())
	}
}

fn sample_tint(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut tint = TintMotion::new(0.0);
	tint.set_target(1.0, tokens, MotionPolicy::DEFAULT, series.at(0));
	let mut out = String::new();
	for ms in [0, 20, 40, 60, 80, 100, 120, 150, 200] {
		let (val, settled) = tint.sample(series.at(ms));
		let _ = writeln!(out, "{ms}ms: val={val:.5} settled={settled}");
	}
	out
}

fn sample_reveal(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut reveal = RevealMotion::new(false);
	reveal.set_expanded(true, tokens, MotionPolicy::DEFAULT, series.at(0));
	let mut out = String::new();
	for ms in [0, 15, 30, 45, 60, 80, 100, 120, 150, 200, 300, 500] {
		let (pos, settled) = reveal.sample(series.at(ms));
		let _ = writeln!(out, "{ms}ms: pos={pos:.5} settled={settled}");
	}
	out
}

fn sample_float(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut float = FloatMotion::new();
	float.set_open(true, tokens, MotionPolicy::DEFAULT, series.at(0));
	let mut out = String::new();
	for ms in [0, 15, 30, 45, 60, 75, 90, 120, 150, 200, 300] {
		let frame = float.sample(series.at(ms));
		let _ = writeln!(
			out,
			"{ms}ms: opacity={:.5} offset_y={:.5} settled={}",
			frame.opacity, frame.offset_y, frame.settled
		);
	}
	out
}

fn sample_panel(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut panel = PanelMotion::new(320.0);
	panel.set_direct(350.0, series.at(20));
	let release = series.at(50);
	panel.set_direct(400.0, release);
	panel.release_to_snap(380.0, tokens, MotionPolicy::DEFAULT, release);
	let mut out = String::new();
	for ms in [60, 70, 80, 100, 120, 150, 200, 300, 500, 1000] {
		let (w, settled) = panel.sample(series.at(ms));
		let _ = writeln!(out, "{ms}ms: width={w:.5} settled={settled}");
	}
	out
}

fn sample_shift(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut shift = ShiftMotion::new();
	shift.record_shift(100.0, 150.0, tokens, MotionPolicy::DEFAULT, series.at(0));
	let mut out = String::new();
	for ms in [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300] {
		let (offset, settled) = shift.sample(series.at(ms));
		let _ = writeln!(out, "{ms}ms: offset={offset:.5} settled={settled}");
	}
	out
}

fn sample_scroll(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut scroll = ScrollMotion::new(0.0);
	scroll.scroll_to(500.0, tokens, MotionPolicy::DEFAULT, series.at(0));
	let mut out = String::new();
	for ms in [0, 30, 60, 90, 120, 150, 180, 210, 240, 300] {
		let (offset, settled) = scroll.sample(series.at(ms));
		let _ = writeln!(out, "{ms}ms: offset={offset:.5} settled={settled}");
	}
	out
}

fn sample_caret(cx: &mut Headless, tokens: &MotionTokens) -> String {
	let mut series = Series::start(cx);
	let mut caret = CaretMotion::new();
	caret.set_streaming(true, tokens, MotionPolicy::DEFAULT, series.at(0));
	let mut out = String::new();
	for ms in [0, 150, 300, 450, 550, 700, 900, 1050, 1200, 1350] {
		let (opacity, settled) = caret.sample(series.at(ms));
		let _ = writeln!(out, "{ms}ms: opacity={opacity:.5} settled={settled}");
	}
	out
}

pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let motion = &tokens.motion;
	vec![
		Observation::Report { name: "motion.tint", text: sample_tint(cx, motion) },
		Observation::Report { name: "motion.reveal", text: sample_reveal(cx, motion) },
		Observation::Report { name: "motion.float", text: sample_float(cx, motion) },
		Observation::Report { name: "motion.panel", text: sample_panel(cx, motion) },
		Observation::Report { name: "motion.shift", text: sample_shift(cx, motion) },
		Observation::Report { name: "motion.scroll", text: sample_scroll(cx, motion) },
		Observation::Report { name: "motion.caret", text: sample_caret(cx, motion) },
	]
}

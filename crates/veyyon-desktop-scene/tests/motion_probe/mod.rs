//! What the motion roles produce, sampled rather than drawn.
//!
//! A still frame shows no animation, so a frame comparison cannot see a
//! stiffness or a duration. Each role is driven through its own animator from
//! a fixed start instant and sampled at a fixed series of offsets, and the
//! series is the observation: doubling any parameter of a role changes the
//! trajectory it reports.

use std::{
	fmt::Write,
	time::{Duration, Instant},
};

use veyyon_desktop_motion::{
	CaretMotion, FloatMotion, MotionTokens, PanelMotion, RevealMotion, ScrollMotion, ShiftMotion,
	SurfaceId, TintMotion,
};
use veyyon_desktop_scene::Headless;
use veyyon_desktop_tokens::Tokens;

use crate::dead_token_probe::Observation;

fn sample_tint(tokens: &MotionTokens, t0: Instant) -> String {
	let mut tint = TintMotion::new(SurfaceId::Queue, 0, 0.0);
	tint.set_target(1.0, tokens, false, t0);
	let mut out = String::new();
	for ms in [0, 20, 40, 60, 80, 100, 120, 150, 200] {
		let t = t0 + Duration::from_millis(ms);
		let (val, settled) = tint.sample(t);
		let _ = writeln!(out, "{ms}ms: val={val:.5} settled={settled}");
	}
	out
}

fn sample_reveal(tokens: &MotionTokens, t0: Instant) -> String {
	let mut reveal = RevealMotion::new(SurfaceId::Queue, 1, false);
	reveal.set_expanded(true, tokens, false, t0);
	let mut out = String::new();
	for ms in [0, 15, 30, 45, 60, 80, 100, 120, 150, 200, 300, 500] {
		let t = t0 + Duration::from_millis(ms);
		let (pos, settled) = reveal.sample(t);
		let _ = writeln!(out, "{ms}ms: pos={pos:.5} settled={settled}");
	}
	out
}

fn sample_float(tokens: &MotionTokens, t0: Instant) -> String {
	let mut float = FloatMotion::new(SurfaceId::Palette, 0);
	let mut out = String::new();
	for ms in [0, 15, 30, 45, 60, 75, 90, 120, 150, 200, 300] {
		let t = t0 + Duration::from_millis(ms);
		let frame = float.sample(true, t, tokens, false);
		let _ = writeln!(
			out,
			"{ms}ms: opacity={:.5} offset_y={:.5} settled={}",
			frame.opacity, frame.offset_y, frame.settled
		);
	}
	out
}

fn sample_panel(tokens: &MotionTokens, t0: Instant) -> String {
	let mut panel = PanelMotion::new(SurfaceId::RightPanel, 0, 320.0);
	panel.set_direct(350.0, t0 + Duration::from_millis(20));
	panel.set_direct(400.0, t0 + Duration::from_millis(50));
	panel.release_to_snap(380.0, tokens, false, t0 + Duration::from_millis(50));
	let mut out = String::new();
	for ms in [60, 70, 80, 100, 120, 150, 200, 300, 500, 1000] {
		let t = t0 + Duration::from_millis(ms);
		let (w, settled) = panel.sample(t);
		let _ = writeln!(out, "{ms}ms: width={w:.5} settled={settled}");
	}
	out
}

fn sample_shift(tokens: &MotionTokens, t0: Instant) -> String {
	let mut shift = ShiftMotion::new(SurfaceId::Queue, 42);
	shift.record_shift(100.0, 150.0, tokens, false, t0);
	let mut out = String::new();
	for ms in [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300] {
		let t = t0 + Duration::from_millis(ms);
		let (offset, settled) = shift.sample(t);
		let _ = writeln!(out, "{ms}ms: offset={offset:.5} settled={settled}");
	}
	out
}

fn sample_scroll(tokens: &MotionTokens, t0: Instant) -> String {
	let mut scroll = ScrollMotion::new(SurfaceId::Transcript, 0, 0.0);
	scroll.scroll_to(500.0, tokens, false, t0);
	let mut out = String::new();
	for ms in [0, 30, 60, 90, 120, 150, 180, 210, 240, 300] {
		let t = t0 + Duration::from_millis(ms);
		let (offset, settled) = scroll.sample(t);
		let _ = writeln!(out, "{ms}ms: offset={offset:.5} settled={settled}");
	}
	out
}

fn sample_caret(tokens: &MotionTokens, t0: Instant) -> String {
	let mut caret = CaretMotion::new(SurfaceId::Composer, 0);
	let mut out = String::new();
	for ms in [0, 150, 300, 450, 550, 700, 900, 1050, 1200, 1350] {
		let t = t0 + Duration::from_millis(ms);
		let (opacity, settled) = caret.sample(true, t, tokens, false);
		let _ = writeln!(out, "{ms}ms: opacity={opacity:.5} settled={settled}");
	}
	out
}

pub fn observations(_cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let motion = MotionTokens::from(tokens.motion.clone());
	let t0 = Instant::now();
	vec![
		Observation::Report { name: "motion.tint", text: sample_tint(&motion, t0) },
		Observation::Report { name: "motion.reveal", text: sample_reveal(&motion, t0) },
		Observation::Report { name: "motion.float", text: sample_float(&motion, t0) },
		Observation::Report { name: "motion.panel", text: sample_panel(&motion, t0) },
		Observation::Report { name: "motion.shift", text: sample_shift(&motion, t0) },
		Observation::Report { name: "motion.scroll", text: sample_scroll(&motion, t0) },
		Observation::Report { name: "motion.caret", text: sample_caret(&motion, t0) },
	]
}

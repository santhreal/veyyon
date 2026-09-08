//! WHY: a plan's body is capped at 400px and the pane clips whatever is past
//! it (§5.5). A hard clip cuts a line of prose through the middle of its
//! glyphs, which reads as a rendering fault rather than as more text: the
//! operator cannot tell a plan that ends there from a plan that continues, so
//! the one control that matters — opening the plan rather than accepting it —
//! is the one the surface fails to suggest. The cut is stated by fading the
//! last 64px into the card's own ground.
//!
//! The fade is a gradient quad, and a gradient carries no solid fill, so the
//! captured layout tree drops it: `layout_box_tree_from_quads` keeps a box only
//! for a solid background or a border. This suite therefore reads pixels. It
//! measures the peak distance from the card's own ground in bands of the pane
//! aimed from the tokens the window installed -- the prose the pane opens with,
//! one probe above the fade's authored height, one halfway down it, and one at
//! the cut -- and compares a body that overruns the cap with one that fits.
//!
//! Each band is read against the opening prose of the same frame rather than
//! against another arm's, so the comparison survives a ramp or a theme change.
//!
//! CLASS CLOSED:
//! 1. The fade going missing, so the cut is a bare clip. The overrunning arm
//!    requires the band at the cut to have lost two thirds of its ink.
//! 2. The fade being drawn unconditionally, dimming the last line of a plan
//!    that fits. The fitting arm requires that band to be as legible as the
//!    line above it.
//! 3. The fade covering more of the pane than the token authors: the band one
//!    probe above the fade's own height is required to keep its ink.
//! 4. The fade covering less: the band halfway down it is required to have lost
//!    ink already, which a fade of half the height leaves untouched.
//! 5. The gradient running the other way, opaque at the top: caught by 1 and 3
//!    together, which pin ink above the fade and no ink at the cut.
//! 6. The cap itself failing, so a long plan grows the stack instead of being
//!    cut: bodies of 3, 40 and 400 lines are required to lay the cards region
//!    out at the same height for the two past the cap.
//!
//! NOT CAUGHT: the exact colour ramp. The assertions are distances from the
//! card's own ground, so a gradient to a near-ground colour rather than to the
//! ground itself passes. The threshold at which a body is judged to overrun is
//! `plan`'s own line-count floor, which this suite exercises far from the
//! boundary on purpose: a body one line over the cap is a `plan` contract and
//! would make this suite depend on shaped wrapping.

#[path = "support/queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
mod queue_scroll;

use std::collections::HashMap;

use queue_scroll::open_session;
use veyyon_desktop_kit::{SpacingStep, TextRamp};
use veyyon_desktop_scene::{
	BoxBounds, Captured, HeadlessSession, RgbaColor, headless::Headless, headless_context,
};
use veyyon_desktop_surface::{Card, ShellState, ShellView, damage::Region, fixture};
use veyyon_gpui::{Bounds, Pixels};

const WINDOW_W: u32 = 1280;
const WINDOW_H: u32 = 900;

/// One line of the plan's body, repeated: every arm reads the same first line,
/// so the first band is comparable across arms.
const LINE: &str = "Replace the hand-built title and subtitle rows with the kit's Truncate.";

/// How tall a probe band is: short enough that the gradient barely changes
/// across it, tall enough to still cross the glyphs of a line of prose.
const PROBE: f32 = 16.0;

/// The geometry this suite measures against, read from the tokens the window
/// installed rather than reloaded here.
struct Metrics {
	/// The pane's own cap.
	cap:      f32,
	/// The fade drawn at the cut.
	fade:     f32,
	/// One line of the body, at the ramp the body is set in.
	line:     f32,
	/// The gap between two lines of the body.
	body_gap: f32,
	/// The gap between the pane and the answer row under it.
	gap:      f32,
	/// The cards region, as the frame laid it out.
	cards:    BoxBounds,
	/// The upper edge of the card's answer row.
	answers:  f32,
}

fn rect(bounds: Bounds<Pixels>) -> BoxBounds {
	BoxBounds {
		left:   f32::from(bounds.origin.x),
		top:    f32::from(bounds.origin.y),
		right:  f32::from(bounds.origin.x) + f32::from(bounds.size.width),
		bottom: f32::from(bounds.origin.y) + f32::from(bounds.size.height),
	}
}

/// A state whose stack holds one plan of `lines` body lines.
fn plan_of(lines: usize) -> ShellState {
	let mut state = fixture::populated();
	state.cards = vec![Card::Plan {
		title: "Move the surface leaves onto kit primitives".to_owned(),
		body:  (0..lines).map(|_| LINE.to_owned()).collect(),
	}];
	state
}

/// Opens the window on that state and reads everything the assertions need.
fn open(cx: &mut Headless, lines: usize) -> (HeadlessSession<'_, ShellView>, Captured, Metrics) {
	let mut session = open_session(cx, plan_of(lines), WINDOW_W, WINDOW_H);
	let captured = session.frame().expect("the shell renders at rest");
	let (cap, fade, line, body_gap, gap) = session
		.update(|view, _window, _cx| {
			let installed = view.installed();
			let geometry = &installed.surface.attached_cards;
			(
				geometry.plan_max_markdown_height_px,
				geometry.plan_fade_height_px,
				f32::from(installed.set.line_height(TextRamp::Small)),
				f32::from(installed.set.spacing(SpacingStep::S1)),
				f32::from(installed.set.spacing(SpacingStep::S2)),
			)
		})
		.expect("the window updates");
	let cards = rect(
		session
			.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Cards))
			.expect("the window updates")
			.expect("a state with a card lays the cards region out"),
	);

	// The card's only hit rects are its two answers, so the row they sit in is
	// the first rect inside the region, and the pane ends one gap above it.
	let answers = captured
		.hitboxes
		.iter()
		.map(|bounds| rect(*bounds))
		.filter(|control| {
			control.top >= cards.top - 0.5
				&& control.bottom <= cards.bottom + 0.5
				&& control.left >= cards.left - 0.5
				&& control.right <= cards.right + 0.5
		})
		.map(|control| control.top)
		.fold(f32::INFINITY, f32::min);
	assert!(
		answers.is_finite(),
		"a plan card offers its answers, so the region carries the rects they answer"
	);

	(session, captured, Metrics { cap, fade, line, body_gap, gap, cards, answers })
}

impl Metrics {
	/// The pane's lower edge: the answers row, less the shell's own gap.
	fn pane_bottom(&self) -> f32 {
		self.answers - self.gap
	}

	/// The band `height` tall whose lower edge is `bottom`.
	fn band(&self, bottom: f32, height: f32) -> BoxBounds {
		BoxBounds { left: self.cards.left, top: bottom - height, right: self.cards.right, bottom }
	}

	/// The band of prose the pane opens with, which the fade never reaches.
	fn first_line(&self) -> BoxBounds {
		let pane_bottom = self.pane_bottom();
		let pane_top = pane_bottom - self.cap.min(pane_bottom - self.cards.top);
		self.band(pane_top + self.line, self.line)
	}

	/// The band of the `n`th line up from the pane's lower edge, where the
	/// zeroth is the line the pane ends on.
	fn line_from_bottom(&self, n: usize) -> BoxBounds {
		let up = (self.line + self.body_gap) * n as f32;
		self.band(self.pane_bottom() - up, self.line)
	}
}

/// The colour the band is drawn against: the one most of the card is.
fn ground(captured: &Captured, area: BoxBounds) -> RgbaColor {
	let mut counts: HashMap<(u8, u8, u8), usize> = HashMap::new();
	for y in area.top.max(0.0) as u32..area.bottom.max(0.0) as u32 {
		for x in area.left.max(0.0) as u32..area.right.max(0.0) as u32 {
			if let Some(colour) = captured.frame.pixel(x, y) {
				*counts.entry((colour.r, colour.g, colour.b)).or_insert(0) += 1;
			}
		}
	}
	let ((r, g, b), _) = counts
		.into_iter()
		.max_by_key(|&(colour, count)| (count, colour))
		.expect("the card covers pixels to read");
	RgbaColor::opaque(r, g, b)
}

/// The furthest any pixel in `area` gets from `ground`, summed over channels.
///
/// A band of prose peaks at the glyph ink; a band the fade has taken back to
/// the card's ground peaks near zero.
fn peak_contrast(captured: &Captured, area: BoxBounds, ground: RgbaColor) -> u32 {
	let mut peak = 0;
	for y in area.top.max(0.0) as u32..area.bottom.max(0.0) as u32 {
		for x in area.left.max(0.0) as u32..area.right.max(0.0) as u32 {
			if let Some(colour) = captured.frame.pixel(x, y) {
				let distance = u32::from(colour.r.abs_diff(ground.r))
					+ u32::from(colour.g.abs_diff(ground.g))
					+ u32::from(colour.b.abs_diff(ground.b));
				peak = peak.max(distance);
			}
		}
	}
	peak
}

/// The peak contrast of the pane's opening prose and of the probe at the cut.
fn first_and_cut(captured: &Captured, metrics: &Metrics) -> (u32, u32) {
	let ground = ground(captured, metrics.cards);
	(
		peak_contrast(captured, metrics.first_line(), ground),
		peak_contrast(captured, metrics.band(metrics.pane_bottom(), PROBE), ground),
	)
}

#[test]
fn a_body_that_fits_is_legible_to_its_last_line() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let (_session, captured, metrics) = open(&mut cx, 3);
	let ground = ground(&captured, metrics.cards);
	let first = peak_contrast(&captured, metrics.line_from_bottom(2), ground);
	let last = peak_contrast(&captured, metrics.band(metrics.pane_bottom(), PROBE), ground);

	assert!(first > 60, "the first line of a plan's body is drawn in ink; peak was {first}");
	assert!(
		last * 100 >= first * 70,
		"nothing was cut off a three-line plan, so its last line is as legible as its first: peak \
		 {last} against {first}"
	);
}

#[test]
fn a_body_cut_at_the_cap_fades_into_the_card_at_the_cut() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let (_session, captured, metrics) = open(&mut cx, 40);
	let (first, cut) = first_and_cut(&captured, &metrics);

	assert!(first > 60, "the top of a cut plan's body is drawn in ink; peak was {first}");
	assert!(
		cut * 100 <= first * 35,
		"the probe at the cut sits under the opaque end of the fade, so what prose is drawn there \
		 has been taken back towards the card's ground: peak {cut} against {first} at the top of \
		 the same pane"
	);
}

#[test]
fn the_fade_reaches_the_token_height_and_no_further() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let (_session, captured, metrics) = open(&mut cx, 40);
	let ground = ground(&captured, metrics.cards);
	let pane_bottom = metrics.pane_bottom();
	let (first, _) = first_and_cut(&captured, &metrics);

	// Three probes across the fade's own height: above it, halfway down it,
	// and at the cut. A fade taller than the token dims the first; a shorter
	// one leaves the second at full ink.
	let above = peak_contrast(&captured, metrics.band(pane_bottom - metrics.fade, PROBE), ground);
	let halfway =
		peak_contrast(&captured, metrics.band(pane_bottom - metrics.fade / 2.0, PROBE), ground);

	assert!(
		above * 100 >= first * 70,
		"the prose one probe above the fade is untouched by it: peak {above} against {first}"
	);
	assert!(
		halfway * 100 <= first * 75,
		"halfway down the fade the prose is already dimmed: peak {halfway} against {first}"
	);
}

/// The height the stack lays out for a plan of `lines` body lines.
///
/// The window is opened, measured and closed before the next one, because one
/// headless renderer at a time is what this harness supports.
fn stack_height(lines: usize) -> (f32, f32) {
	let mut cx = headless_context().expect("a headless renderer is required");
	let (_session, _frame, metrics) = open(&mut cx, lines);
	(metrics.cards.height(), metrics.cap)
}

#[test]
fn the_cap_holds_however_long_the_body_is() {
	let (short, cap) = stack_height(40);
	let (long, _) = stack_height(120);

	assert!(
		(short - long).abs() < 0.5,
		"a body three times further past the cap is cut at the same place, so the stack is the same \
		 height: {short}px against {long}px"
	);
	assert!(
		short > cap,
		"the card holding a capped pane is taller than the cap itself: {short}px against {cap}px"
	);
}

//! WHY: The composer's primary control draws one static up-arrow in every turn
//! phase (§5.4), so the only thing that states what a click will do is the
//! hover tag. The defect this closes is that tag being unreachable: it opened
//! downwards from a control sitting on the last row of the window, landing
//! under the attention strip painted after it, and ran rightwards off the
//! column's clipped edge. Both leave a control whose meaning is stated
//! nowhere, and neither shows up in a test that only asserts the label string.
//!
//! The class is "a hover tag that exists in the element tree and reaches no
//! pixel". The suite sweeps every turn phase from `TurnPhaseDiscriminant`, so a
//! new phase is swept the day it is added, and for each one asserts:
//!
//! 1. Hovering the primary control paints text that was not painted before.
//! 2. That text lies wholly inside the window.
//! 3. It opens above the control rather than below it, where the composer row
//!    and the attention strip are.
//! 4. It stays inside the composer column horizontally.
//! 5. The pixels under it change, which is the difference between painted and
//!    merely laid out.
//! 6. The tag measures the width its own action name shapes to in the window's
//!    text system, so one generic tag stating the same words in every phase
//!    fails.
//!
//! Gap left: the shaped glyphs are not read back, so the sweep proves a tag as
//! wide as its own name in the right place rather than the exact string; two
//! names that shape to the same width would pass each other's check. The names
//! themselves are pinned byte for byte by
//! `every_turn_action_states_itself_in_its_name_because_the_glyph_never_changes`
//! at the end of this file, which is where a renamed action is caught. Width
//! alone is not the contract: in a proportional face "Send message" and
//! "Submit answer" shape to within 0.4px of each other, so comparing phases
//! against each other proves nothing about either.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use composer_layout::{
	TurnPhaseDiscriminant, build_state_for_phase, composer_float_bounds, find_primary_action_hitbox,
	render_session,
};
use strum::IntoEnumIterator;
use veyyon_desktop_kit::{ColorRole, TextRamp};
use veyyon_desktop_scene::frame::RgbaFrame;
use veyyon_desktop_surface::composer::{PrimaryAction, primary_action};
use veyyon_gpui::{
	Bounds, Font, FontFeatures, FontStyle, FontWeight, Pixels, Point, SharedString, TextRun,
};

/// Window size the sweep renders at. Height is deliberately modest: the tag's
/// room below the control is what the defect depended on.
const WIDTH: u32 = 1180;
const HEIGHT: u32 = 800;

/// A painted text run, in logical pixels, reduced to the numbers this suite
/// reasons about.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Run {
	left:   f32,
	top:    f32,
	right:  f32,
	bottom: f32,
}

impl Run {
	fn from_bounds(bounds: Bounds<Pixels>) -> Self {
		Self {
			left:   f32::from(bounds.origin.x),
			top:    f32::from(bounds.origin.y),
			right:  f32::from(bounds.origin.x + bounds.size.width),
			bottom: f32::from(bounds.origin.y + bounds.size.height),
		}
	}

	fn width(self) -> f32 {
		self.right - self.left
	}

	fn matches(self, other: Self) -> bool {
		(self.left - other.left).abs() <= 0.5
			&& (self.top - other.top).abs() <= 0.5
			&& (self.right - other.right).abs() <= 0.5
			&& (self.bottom - other.bottom).abs() <= 0.5
	}
}

/// Counts pixels that differ between two frames inside `rect`.
fn changed_pixels(before: &RgbaFrame, after: &RgbaFrame, rect: Run) -> u32 {
	let mut changed = 0;
	let left = rect.left.floor().max(0.0) as u32;
	let top = rect.top.floor().max(0.0) as u32;
	let right = rect.right.ceil().max(0.0) as u32;
	let bottom = rect.bottom.ceil().max(0.0) as u32;
	for y in top..bottom {
		for x in left..right {
			if before.pixel(x, y) != after.pixel(x, y) {
				changed += 1;
			}
		}
	}
	changed
}

/// One phase's hover: the tag's run, the control's own rect, the pixels the
/// tag changed where it opened, and the action name the phase resolves to.
struct Hover {
	tag:      Run,
	control:  Run,
	changed:  u32,
	label:    &'static str,
	/// The width `label` shapes to in the window's own text system, at the
	/// size and family the tag draws in.
	measured: f32,
}

/// Renders a phase and hovers the primary control.
fn hover_the_primary(discriminant: TurnPhaseDiscriminant) -> Hover {
	let (state, has_text) = build_state_for_phase(discriminant);
	let seed_text = has_text.then_some("test instructions");

	render_session(state, seed_text, WIDTH, HEIGHT, |session| {
		let label = session
			.update(|view, _window, _cx| {
				primary_action(&view.state().turn, view.has_composer_text())
					.0
					.label()
			})
			.expect("primary action resolves");
		let (_left, _top, right, bottom) = composer_float_bounds(session, WIDTH, HEIGHT);
		let resting = session.frame().expect("resting frame renders");
		let control = find_primary_action_hitbox(&resting.hitboxes, right, bottom)
			.expect("primary action control is hit-testable");
		let before: Vec<Run> = resting
			.text_runs
			.iter()
			.map(|r| Run::from_bounds(r.bounds))
			.collect();

		let center = Point {
			x: control.origin.x + control.size.width / 2.0,
			y: control.origin.y + control.size.height / 2.0,
		};
		session
			.hover(center)
			.expect("pointer moves onto the control");
		let hovered = session.frame().expect("hovered frame renders");

		let mut revealed: Vec<Run> = hovered
			.text_runs
			.iter()
			.map(|r| Run::from_bounds(r.bounds))
			.filter(|run| !before.iter().any(|seen| seen.matches(*run)))
			.collect();

		assert_eq!(
			revealed.len(),
			1,
			"{discriminant:?}: hovering the primary control paints exactly one new text run, the \
			 action's name; got {revealed:?}"
		);
		let tag = revealed.remove(0);
		let changed = changed_pixels(&resting.frame, &hovered.frame, tag);
		// The oracle is the window's own text system at the tag's size and
		// family, so the assertion holds on whatever face the machine
		// resolved the authored chain to.
		let measured = session
			.update(|view, window, _cx| {
				let tokens = &view.installed().set;
				let run = TextRun {
					len:              label.len(),
					font:             Font {
						family:    tokens.ui_family(),
						features:  FontFeatures::default(),
						fallbacks: None,
						weight:    FontWeight::default(),
						style:     FontStyle::default(),
					},
					color:            tokens.color(ColorRole::Foreground),
					background_color: None,
					underline:        None,
					strikethrough:    None,
				};
				let size = tokens.font_size(TextRamp::Small);
				let shaped =
					window
						.text_system()
						.shape_line(SharedString::from(label), size, &[run], None);
				f32::from(shaped.width)
			})
			.expect("the label shapes in the window's text system");

		Hover { tag, control: Run::from_bounds(control), changed, label, measured }
	})
}

#[test]
fn every_turn_phase_states_its_primary_action_on_hover_inside_the_window() {
	for discriminant in TurnPhaseDiscriminant::iter() {
		let Hover { tag, control, changed, label: _, measured: _ } = hover_the_primary(discriminant);

		assert!(
			tag.left >= 0.0 && tag.top >= 0.0,
			"{discriminant:?}: the tag starts inside the window, at {tag:?}"
		);
		assert!(
			tag.right <= WIDTH as f32 && tag.bottom <= HEIGHT as f32,
			"{discriminant:?}: the tag ends inside the {WIDTH}x{HEIGHT} window, at {tag:?}"
		);
		assert!(
			tag.bottom <= control.top,
			"{discriminant:?}: the tag opens above the control at {control:?}, because the composer \
			 is the last row and the attention strip paints over anything below it; got {tag:?}"
		);
		assert!(
			tag.right <= control.right + 1.0,
			"{discriminant:?}: the tag stays within the control's right edge {}, or the column clips \
			 it; got {tag:?}",
			control.right
		);
		assert!(
			changed >= 40,
			"{discriminant:?}: the tag's own rect changes pixels when it opens, or it is laid out \
			 under something else; only {changed} pixels differ in {tag:?}"
		);
	}
}

#[test]
fn a_tag_is_as_wide_as_the_action_name_it_states() {
	let mut widths: Vec<(TurnPhaseDiscriminant, &'static str, f32)> = Vec::new();
	for discriminant in TurnPhaseDiscriminant::iter() {
		let hover = hover_the_primary(discriminant);
		let drawn = hover.tag.width();
		assert!(drawn > 0.0, "{discriminant:?}: the tag has width");
		// One pixel covers layout rounding; a tag stating another phase's name
		// misses by the difference between two names, which is larger.
		assert!(
			(drawn - hover.measured).abs() <= 1.0,
			"{discriminant:?}: the tag is {drawn}px wide and {:?} shapes to {}px, so the tag is \
			 stating something else",
			hover.label,
			hover.measured
		);
		widths.push((discriminant, hover.label, drawn));
	}

	for (phase, label, width) in &widths {
		for (other_phase, other_label, other_width) in &widths {
			if phase != other_phase && label == other_label {
				assert!(
					(width - other_width).abs() <= 1.0,
					"{phase:?} and {other_phase:?} both state {label:?}, so their tags measure the \
					 same; got {width} and {other_width}"
				);
			}
		}
	}
}
#[test]
fn every_turn_action_states_itself_in_its_name_because_the_glyph_never_changes() {
	// §5.4 draws one up arrow in every turn state, so the accessible name is
	// the only place the action is stated: a screen reader and the control's
	// tooltip both read it, and a native capture of the two running modes
	// differs in nothing else. The table is asserted exactly, per action,
	// because these bytes are what a reader is given.
	let authored = [
		(PrimaryAction::Send, "Send message"),
		(PrimaryAction::Steer, "Steer turn"),
		(PrimaryAction::Queue, "Queue message"),
		(PrimaryAction::Answer, "Submit answer"),
		(PrimaryAction::Approve, "Approve request"),
		(PrimaryAction::Accept, "Accept plan"),
		(PrimaryAction::Refine, "Refine plan"),
	];
	assert_eq!(
		authored.len(),
		PrimaryAction::ALL.len(),
		"a new primary action arrives here before it reaches an operator"
	);
	for (action, name) in authored {
		assert!(
			PrimaryAction::ALL.contains(&action),
			"{action:?} is not one of the actions the composer offers"
		);
		assert_eq!(action.label(), name, "the name {action:?} is given");
	}

	let mut names: Vec<&str> = PrimaryAction::ALL
		.iter()
		.map(|action| action.label())
		.collect();
	names.sort_unstable();
	let distinct = names.len();
	names.dedup();
	assert_eq!(
		names.len(),
		distinct,
		"two actions sharing a name leave one of them unstated, since the shape does not \
		 distinguish them: {names:?}"
	);
}

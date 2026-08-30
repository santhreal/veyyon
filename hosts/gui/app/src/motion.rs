//! Time, curves, and every animated value in the window.
//!
//! One mechanism. A channel is a number on its way somewhere, addressed by a
//! [`Key`], and everything that moves is one: a pane's width, a panel's height,
//! a row's hover wash, a group's disclosure, a sheet arriving, a card's first
//! appearance, a chip's fade. The shell holds one [`Motion`], reads channels
//! while it builds the frame, and advances all of them once at the end.
//!
//! THE CLOCK IS AN ARGUMENT. Nothing here calls into the clock. Every function
//! takes `now`, in milliseconds since the window opened, which is the same
//! number `state::moves::tick` runs on. Two consequences, and both are the
//! reason for the shape:
//!
//! - Every value in one frame is evaluated at exactly one instant, so two
//!   things told to move together provably move together.
//! - The whole layer is tested at exact millisecond boundaries with no sleeping
//!   and no window. A test asserts where a tween is at 100ms because it says
//!   100, not because it slept and hoped.
//!
//! WHAT IS NOT HERE. gpui's `with_animation` and its friends. That element
//! keys its start time by the element-id path, so an ancestor remount replays
//! the animation from zero, which is a full-brightness flash in the middle of a
//! fade. Every value here is evaluated from the shell's own clock instead, so a
//! remount is exactly the steady state and the element tree's shape is free to
//! change.

use std::{
	collections::hash_map::DefaultHasher,
	hash::{Hash, Hasher},
};

use gpui::{Hsla, Rgba};

/// A CSS `cubic-bezier(x1, y1, x2, y2)`, with the endpoints fixed at (0,0) and
/// (1,1). Evaluated by Newton iteration on x(t) with a bisection fallback.
///
/// The curves the window uses are named below; this exists so those names are
/// the exact curves a browser would draw, rather than an approximation of them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Curve {
	pub x1: f32,
	pub y1: f32,
	pub x2: f32,
	pub y2: f32,
}

impl Curve {
	pub const fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Curve {
		Curve { x1, y1, x2, y2 }
	}

	/// Polynomial coefficients of one axis of the unit bezier.
	fn axis(a: f32, b: f32) -> (f32, f32, f32) {
		let c = 3.0 * a;
		let b2 = 3.0 * (b - a) - c;
		(1.0 - c - b2, b2, c)
	}

	fn x_at(self, t: f32) -> f32 {
		let (a, b, c) = Curve::axis(self.x1, self.x2);
		((a * t + b) * t + c) * t
	}

	fn y_at(self, t: f32) -> f32 {
		let (a, b, c) = Curve::axis(self.y1, self.y2);
		((a * t + b) * t + c) * t
	}

	fn dx_at(self, t: f32) -> f32 {
		let (a, b, c) = Curve::axis(self.x1, self.x2);
		(3.0 * a * t + 2.0 * b) * t + c
	}

	fn t_for_x(self, x: f32) -> f32 {
		let mut t = x;
		for _ in 0..8 {
			let error = self.x_at(t) - x;
			if error.abs() < 1e-6 {
				return t;
			}
			let slope = self.dx_at(t);
			if slope.abs() < 1e-6 {
				break;
			}
			t -= error / slope;
		}
		let (mut low, mut high) = (0.0_f32, 1.0_f32);
		for _ in 0..32 {
			let middle = (low + high) / 2.0;
			if self.x_at(middle) < x {
				low = middle;
			} else {
				high = middle;
			}
		}
		(low + high) / 2.0
	}

	/// Eased output for a progress in 0..1, clamped at both ends.
	///
	/// The clamp on the output is load bearing rather than defensive: f32
	/// rounding puts `y_at` a hair above 1.0 near the tail of the sharper
	/// curves, and an opacity above 1.0 is a panic one layer down.
	pub fn at(self, x: f32) -> f32 {
		if x <= 0.0 {
			return 0.0;
		}
		if x >= 1.0 {
			return 1.0;
		}
		self.y_at(self.t_for_x(x)).clamp(0.0, 1.0)
	}
}

/// The entrance curve: leaves fast, lands slow, almost arrived by the halfway
/// point. CSS `cubic-bezier(0.16, 1, 0.3, 1)`.
pub const EXPO_OUT: Curve = Curve::new(0.16, 1.0, 0.3, 1.0);
/// CSS `ease-out`. Widths and heights.
pub const OUT: Curve = Curve::new(0.0, 0.0, 0.58, 1.0);
/// CSS `ease`. Fades, sheets, chips.
pub const EASE: Curve = Curve::new(0.25, 0.1, 0.25, 1.0);
/// CSS `ease-in-out`. A value moving between two resting states, and a scroll.
pub const IN_OUT: Curve = Curve::new(0.42, 0.0, 0.58, 1.0);
/// CSS `ease-in`. Only for something leaving.
pub const IN: Curve = Curve::new(0.42, 0.0, 1.0, 1.0);
/// The curve a colour transition rides. CSS `cubic-bezier(0.4, 0, 0.2, 1)`.
pub const COLOR: Curve = Curve::new(0.4, 0.0, 0.2, 1.0);

/// One motion: how long, along which curve.
///
/// There is no delay field. Nothing in the window waits before it starts
/// moving, and a stagger built out of per-element delays is a stagger that has
/// to be kept in step by hand.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spec {
	pub duration_ms: u32,
	pub curve:       Curve,
}

impl Spec {
	pub const fn new(duration_ms: u32, curve: Curve) -> Spec {
		Spec { duration_ms, curve }
	}

	/// Eased progress `elapsed` milliseconds in.
	pub fn at_ms(self, elapsed_ms: u32) -> f32 {
		if self.duration_ms == 0 {
			return 1.0;
		}
		self.curve.at(elapsed_ms as f32 / self.duration_ms as f32)
	}
}

/// A card, a row or a message appearing: 260ms, fast out of the gate.
pub const ENTER: Spec = Spec::new(260, EXPO_OUT);
/// A fade with nothing else attached.
pub const FADE: Spec = Spec::new(150, EASE);
/// A pane's width or a panel's height.
pub const RESIZE: Spec = Spec::new(200, OUT);
/// A group folding or unfolding.
pub const COLLAPSE: Spec = Spec::new(180, OUT);
/// A sheet arriving over the window.
pub const SHEET_IN: Spec = Spec::new(180, EASE);
/// A sheet leaving. Shorter than it arrives: waiting for something to go is
/// dead time.
pub const SHEET_OUT: Spec = Spec::new(110, IN);

// A sheet's exit stays shorter than its entrance: waiting for something to go
// is dead time, and retiming either constant past the other reads as a stall.
const _: () = assert!(SHEET_OUT.duration_ms < SHEET_IN.duration_ms);

/// A hover wash. The browser's `transition-colors` default, which is what the
/// eye is calibrated to from every other application on the machine.
pub const WASH: Spec = Spec::new(150, COLOR);
/// A knob travelling from one end of its track to the other. Slower than a
/// fade, because the travel is the whole of what it says.
pub const GLIDE: Spec = Spec::new(220, IN_OUT);
/// The caret's half-period.
pub const BLINK_MS: u32 = 530;

/// Which value a channel is. The address, with [`Key`], of every number that
/// moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
	/// The sidebar's width.
	SidebarWidth,
	/// The palette sheet's arrival, and its departure.
	Sheet,
	/// The notice line under the composer.
	Notice,
	/// One session row's hover wash.
	Row,
	/// One session row's first appearance.
	RowEnter,
	/// One project group's disclosure.
	Group,
	/// One button or chip's hover wash.
	Control,
	/// One message's first appearance.
	Message,
}

/// A channel's address: what kind of value, and which one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
	pub channel: Channel,
	pub id:      u64,
}

impl Key {
	/// The single channel of its kind.
	pub const fn of(channel: Channel) -> Key {
		Key { channel, id: 0 }
	}

	/// One of many, addressed by a number.
	pub const fn at(channel: Channel, id: u64) -> Key {
		Key { channel, id }
	}

	/// One of many, addressed by a name.
	///
	/// The name is hashed rather than stored, so a row's key costs no
	/// allocation and no string comparison. A collision would blend two rows'
	/// hover washes, which is why this is a 64-bit hash and not a truncation.
	pub fn named(channel: Channel, name: &str) -> Key {
		let mut hasher = DefaultHasher::new();
		name.hash(&mut hasher);
		Key { channel, id: hasher.finish() }
	}
}

/// One channel: where it started, where it is going, and when it left.
#[derive(Debug, Clone, Copy)]
struct Track {
	key:     Key,
	from:    f32,
	to:      f32,
	spec:    Spec,
	/// When this leg started, on the shell's clock.
	started: u64,
	/// Read since the last [`Motion::advance`]. A channel that goes a whole
	/// frame unread belongs to an element that is no longer drawn.
	touched: bool,
}

impl Track {
	fn value(&self, now: u64, scale: f32) -> f32 {
		let total = (self.spec.duration_ms as f32 * scale) as u32;
		if total == 0 {
			return self.to;
		}
		let elapsed = now.saturating_sub(self.started);
		if elapsed >= total as u64 {
			return self.to;
		}
		// The scale stretches the wall clock, so the progress the curve is
		// asked for is the unscaled elapsed time.
		let unscaled = (elapsed as f32 / scale) as u32;
		lerp(self.from, self.to, self.spec.at_ms(unscaled))
	}

	fn moving(&self, now: u64, scale: f32) -> bool {
		let total = (self.spec.duration_ms as f32 * scale) as u64;
		now.saturating_sub(self.started) < total && (self.to - self.from).abs() > f32::EPSILON
	}

	/// When this channel next wants a frame, in milliseconds from `now`.
	fn next_frame(&self, now: u64, scale: f32) -> Option<u32> {
		self.moving(now, scale).then_some(0)
	}
}

/// Every animated value in the window.
pub struct Motion {
	tracks:  Vec<Track>,
	/// Set from the platform's accessibility flag once a frame. Under reduced
	/// motion every channel reports its target and no frame is requested.
	reduced: bool,
	/// Stretches every timeline, for looking at a 200ms tween one frame at a
	/// time. Read from the environment once, at construction, so the arithmetic
	/// above stays pure.
	scale:   f32,
}

impl Default for Motion {
	fn default() -> Motion {
		Motion::new()
	}
}

impl Motion {
	pub fn new() -> Motion {
		Motion { tracks: Vec::new(), reduced: false, scale: env_scale() }
	}

	/// Honour the platform's reduced-motion setting. Called once a frame.
	pub fn set_reduced(&mut self, reduced: bool) {
		self.reduced = reduced;
	}

	fn find(&mut self, key: Key) -> Option<usize> {
		// A window has a few dozen live channels, all of them Copy and 40 bytes
		// wide. A linear scan over that is one cache line's work and beats a
		// hash map that would have to own its keys.
		self.tracks.iter().position(|track| track.key == key)
	}

	/// A value that is where it is told to be, animating whenever the
	/// destination changes.
	///
	/// The first sight of a channel is at rest on `target`: a sidebar that
	/// opens at 268 does not slide in from zero on the first frame, and a row
	/// that has never been hovered is not mid-fade.
	pub fn drive(&mut self, key: Key, spec: Spec, target: f32, now: u64) -> f32 {
		match self.find(key) {
			Some(index) => {
				let current = self.tracks[index].value(now, self.scale);
				let track = &mut self.tracks[index];
				track.touched = true;
				if (track.to - target).abs() > f32::EPSILON {
					track.from = current;
					track.to = target;
					track.spec = spec;
					track.started = now;
				}
				if self.reduced {
					target
				} else {
					self.tracks[index].value(now, self.scale)
				}
			},
			None => {
				self.tracks.push(Track {
					key,
					from: target,
					to: target,
					spec,
					started: now,
					touched: true,
				});
				target
			},
		}
	}

	/// Put a channel exactly where it is told, with no motion.
	///
	/// What a drag uses. A width followed by a pointer is already smooth, and
	/// easing toward the pointer's position adds 200ms of lag to every
	/// movement of the hand.
	pub fn snap(&mut self, key: Key, value: f32, now: u64) {
		match self.find(key) {
			Some(index) => {
				let track = &mut self.tracks[index];
				track.from = value;
				track.to = value;
				track.started = now;
				track.touched = true;
			},
			None => {
				self.tracks.push(Track {
					key,
					from: value,
					to: value,
					spec: RESIZE,
					started: now,
					touched: true,
				});
			},
		}
	}

	/// A value that runs 0 to 1 the first time it is seen, and stays at 1.
	///
	/// This is an entrance. It is the same channel as everything else, so an
	/// element that appears, is removed and appears again animates again, and
	/// one that merely remounts inside the same frame tree does not.
	pub fn enter(&mut self, key: Key, spec: Spec, now: u64) -> f32 {
		if self.find(key).is_none() {
			self
				.tracks
				.push(Track { key, from: 0.0, to: 1.0, spec, started: now, touched: true });
			if self.reduced {
				return 1.0;
			}
			return 0.0;
		}
		self.drive(key, spec, 1.0, now)
	}

	/// Retarget a channel from outside the frame: a pointer entering a row, a
	/// group being folded.
	///
	/// Separate from [`Motion::drive`] because it is the event path. A hover
	/// arrives between frames and its motion starts then, not at the next
	/// frame's clock.
	pub fn flip(&mut self, key: Key, on: bool, spec: Spec, now: u64) {
		let target = if on { 1.0 } else { 0.0 };
		if self.find(key).is_none() && !on {
			// A leave for something that was never entered. Nothing to do, and
			// creating a channel here is how a registry fills up with zeroes.
			return;
		}
		self.drive(key, spec, target, now);
	}

	/// Where a channel is, without creating one. 0 if it does not exist.
	pub fn value(&mut self, key: Key, now: u64) -> f32 {
		match self.find(key) {
			Some(index) => {
				self.tracks[index].touched = true;
				if self.reduced {
					self.tracks[index].to
				} else {
					self.tracks[index].value(now, self.scale)
				}
			},
			None => 0.0,
		}
	}

	/// End the frame: drop channels nobody looked at, and drop the ones that
	/// have settled back to rest.
	///
	/// Returns whether anything still moves.
	///
	/// The untouched sweep is what keeps a hover wash from outliving its row. A
	/// row unmounted while the pointer is over it never receives the leave
	/// event, so its channel would sit at 1.0 forever and the row would come
	/// back already lit. Reading a channel is the only way to observe it, so a
	/// channel unread for a whole frame is unobservable and can go.
	pub fn advance(&mut self, now: u64) -> bool {
		let scale = self.scale;
		let mut moving = false;
		self.tracks.retain_mut(|track| {
			if !track.touched {
				return false;
			}
			track.touched = false;
			if track.moving(now, scale) {
				moving = true;
				return true;
			}
			// Settled at zero is the same as absent, so it costs nothing to
			// forget and saves the scan.
			track.to != 0.0
		});
		if self.reduced {
			return false;
		}
		moving
	}

	/// How long until the window needs another frame, in milliseconds, or
	/// `None` if it needs none. Zero means the next display frame.
	pub fn next_frame_after(&mut self, now: u64) -> Option<u32> {
		if self.reduced {
			return None;
		}
		let scale = self.scale;
		self
			.tracks
			.iter()
			.filter_map(|track| track.next_frame(now, scale))
			.min()
	}

	/// How many channels are live.
	///
	/// Registry growth is not observable through a value, because an absent
	/// channel and a channel resting at zero both read as zero. The sweep is
	/// checkable only by counting, and this module's tests are the only reader,
	/// so it is compiled for them.
	#[cfg(test)]
	fn len(&self) -> usize {
		self.tracks.len()
	}

	#[cfg(test)]
	fn is_empty(&self) -> bool {
		self.tracks.is_empty()
	}
}

/// Straight-line interpolation.
pub fn lerp(from: f32, to: f32, t: f32) -> f32 {
	from + (to - from) * t
}

/// Blend two colours the way a browser transitions them: component
/// interpolation with premultiplied alpha.
///
/// Premultiplied is the whole point. A wash fading in from transparent black
/// interpolated naively passes through grey, so a white hover on a dark row
/// dims before it brightens.
pub fn mix(from: Hsla, to: Hsla, t: f32) -> Hsla {
	let t = t.clamp(0.0, 1.0);
	if t <= 0.0 {
		return from;
	}
	if t >= 1.0 {
		return to;
	}
	let (start, end) = (Rgba::from(from), Rgba::from(to));
	let a = lerp(start.a, end.a, t);
	if a <= f32::EPSILON {
		return Hsla::from(Rgba { a: 0.0, ..end });
	}
	Hsla::from(Rgba {
		r: lerp(start.r * start.a, end.r * end.a, t) / a,
		g: lerp(start.g * start.a, end.g * end.a, t) / a,
		b: lerp(start.b * start.a, end.b * end.a, t) / a,
		a,
	})
}

/// `VEYYON_MOTION_SCALE` stretches every timeline, for stepping through a 200ms
/// tween a frame at a time. Never set in ordinary use.
fn env_scale() -> f32 {
	std::env::var("VEYYON_MOTION_SCALE")
		.ok()
		.and_then(|value| value.parse::<f32>().ok())
		.filter(|scale| scale.is_finite())
		.map(|scale| scale.clamp(0.01, 100.0))
		.unwrap_or(1.0)
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! An animation layer fails in ways a screenshot cannot show and a person
	//! only feels: a reversal that snaps because the tween restarted from its
	//! target, a channel that never reports itself finished so the window
	//! repaints at the display's full rate forever, a hover wash that outlives
	//! the row it belonged to and comes back already lit, an eased value a hair
	//! outside 0..1 that panics one layer down as an opacity.
	//!
	//! Every one of those is arithmetic over a clock, and the clock is an
	//! argument here, so all of it is asserted at exact milliseconds with no
	//! sleeping and no window.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the motion looks right. The curves are
	//! pinned to the CSS ones by value at five points each, which is the part
	//! that can be wrong arithmetically rather than by taste.

	use super::*;

	fn close(actual: f32, expected: f32, tolerance: f32, what: &str) {
		assert!(
			(actual - expected).abs() <= tolerance,
			"{what}: got {actual}, expected {expected} ±{tolerance}"
		);
	}

	#[test]
	fn a_linear_bezier_is_the_identity() {
		let linear = Curve::new(0.0, 0.0, 1.0, 1.0);
		for x in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
			close(linear.at(x), x, 1e-4, "linear");
		}
	}

	#[test]
	fn the_curves_are_the_css_curves_by_value() {
		// References solved independently by bisection to 1e-6. A curve that
		// drifts from these is no longer the shape the rest of the machine's
		// software moves with, which is the only reason to use CSS curves.
		let cases: [(&str, Curve, [f32; 5]); 4] = [
			("expo-out", EXPO_OUT, [0.494391, 0.825622, 0.971779, 0.997677, 0.999878]),
			("ease-out", OUT, [0.160572, 0.378138, 0.684643, 0.906535, 0.982973]),
			("ease", EASE, [0.094796, 0.408511, 0.802403, 0.960459, 0.994316]),
			("ease-in-out", IN_OUT, [0.019151, 0.129405, 0.5, 0.870595, 0.980849]),
		];
		for (name, curve, expected) in cases {
			for (x, want) in [0.1, 0.25, 0.5, 0.75, 0.9].into_iter().zip(expected) {
				close(curve.at(x), want, 1e-3, name);
			}
		}
	}

	#[test]
	fn an_eased_value_never_escapes_the_unit_interval() {
		// f32 rounding puts the sharper curves a hair above 1.0 near the tail.
		// A value above 1.0 handed to an opacity is a panic, so the sweep is
		// dense and includes the values closest to the endpoint.
		for curve in [EXPO_OUT, OUT, EASE, IN_OUT, IN, COLOR] {
			for step in 0..=20_000u32 {
				let x = step as f32 / 20_000.0;
				let y = curve.at(x);
				assert!((0.0..=1.0).contains(&y), "at({x}) = {y} escaped 0..1");
			}
			for x in [0.999_999_f32, 0.999_999_9, 1.0 - f32::EPSILON] {
				assert!((0.0..=1.0).contains(&curve.at(x)));
			}
		}
	}

	#[test]
	fn every_curve_starts_at_nothing_ends_at_everything_and_clamps_outside() {
		for curve in [EXPO_OUT, OUT, EASE, IN_OUT, IN, COLOR] {
			assert_eq!(curve.at(0.0), 0.0);
			assert_eq!(curve.at(1.0), 1.0);
			assert_eq!(curve.at(-0.5), 0.0);
			assert_eq!(curve.at(1.5), 1.0);
		}
	}

	#[test]
	fn the_curves_never_go_backwards() {
		for curve in [EXPO_OUT, OUT, EASE, IN_OUT, IN, COLOR] {
			let mut last = 0.0;
			for step in 0..=1_000 {
				let y = curve.at(step as f32 / 1_000.0);
				assert!(y >= last - 1e-4, "{curve:?} went backwards at {step}");
				last = y;
			}
		}
	}

	#[test]
	fn a_spec_starts_at_zero_and_ends_at_one() {
		let spec = Spec::new(200, EASE);
		assert_eq!(spec.at_ms(0), 0.0, "a motion that has not started has not moved");
		assert!(spec.at_ms(100) > 0.0, "halfway through the duration is halfway in");
		assert_eq!(spec.at_ms(200), 1.0, "the end of the duration is the end of the motion");
		assert_eq!(spec.at_ms(9_000), 1.0, "past the end stays at the end");
	}

	#[test]
	fn a_zero_length_motion_is_already_there() {
		assert_eq!(Spec::new(0, EASE).at_ms(0), 1.0);
	}

	#[test]
	fn the_catalog_is_the_timing_the_window_was_tuned_at() {
		// Not decoration: these numbers are what the window's feel was set by,
		// and a change to one of them is a change to the product that should
		// be made deliberately rather than by editing a constant in passing.
		assert_eq!((ENTER.duration_ms, ENTER.curve), (260, EXPO_OUT));
		assert_eq!((RESIZE.duration_ms, RESIZE.curve), (200, OUT));
		assert_eq!((COLLAPSE.duration_ms, COLLAPSE.curve), (180, OUT));
		assert_eq!((WASH.duration_ms, WASH.curve), (150, COLOR));
	}

	#[test]
	fn the_first_sight_of_a_driven_value_is_at_rest_on_its_target() {
		// A sidebar that is open at startup is open, not sliding in.
		let mut motion = Motion::new();
		let key = Key::of(Channel::SidebarWidth);
		assert_eq!(motion.drive(key, RESIZE, 268.0, 0), 268.0);
		assert!(!motion.advance(0), "a value at rest asked for a frame");
		assert_eq!(motion.next_frame_after(0), None, "a value at rest asked for a frame");
	}

	#[test]
	fn a_driven_value_travels_to_a_new_target_and_arrives() {
		let mut motion = Motion::new();
		let key = Key::of(Channel::SidebarWidth);
		motion.drive(key, RESIZE, 0.0, 0);
		motion.drive(key, RESIZE, 200.0, 0);

		let quarter = motion.drive(key, RESIZE, 200.0, 50);
		assert!(quarter > 0.0 && quarter < 200.0, "did not travel: {quarter}");
		assert_eq!(motion.next_frame_after(50), Some(0), "a moving value wants the next frame");

		assert_eq!(motion.drive(key, RESIZE, 200.0, 200), 200.0);
		assert_eq!(motion.next_frame_after(200), None, "an arrived value still wants frames");
	}

	#[test]
	fn restating_a_target_every_frame_does_not_restart_the_motion() {
		// The render path re-states every target on every frame by
		// construction. A tween that restarts on a re-statement never arrives.
		let mut motion = Motion::new();
		let key = Key::of(Channel::SidebarWidth);
		motion.drive(key, RESIZE, 0.0, 0);
		motion.drive(key, RESIZE, 260.0, 0);
		let mut last = 0.0;
		for now in [16, 32, 48, 64, 80, 96] {
			let value = motion.drive(key, RESIZE, 260.0, now);
			assert!(value >= last, "went backwards at {now}: {last} then {value}");
			last = value;
		}
		assert_eq!(motion.drive(key, RESIZE, 260.0, 200), 260.0);
	}

	#[test]
	fn a_reversal_continues_from_where_the_value_actually_is() {
		// The defect this closes: a panel toggled twice quickly jumps to the
		// far end and slides back, because the second leg started from the
		// first leg's target instead of from the value on screen.
		let mut motion = Motion::new();
		let key = Key::of(Channel::SidebarWidth);
		motion.drive(key, RESIZE, 0.0, 0);
		motion.drive(key, RESIZE, 260.0, 0);
		let midway = motion.drive(key, RESIZE, 260.0, 100);
		assert!(midway > 0.0 && midway < 260.0);

		motion.drive(key, RESIZE, 0.0, 100);
		let after = motion.value(key, 100);
		close(after, midway, 1.0, "a reversal jumped instead of continuing");
	}

	#[test]
	fn an_entrance_runs_once_and_a_remount_does_not_replay_it() {
		// This is the whole reason the window does not use an element-keyed
		// animation: the tree remounts constantly and a replay is a flash.
		let mut motion = Motion::new();
		let key = Key::named(Channel::Message, "message-7");
		assert_eq!(motion.enter(key, ENTER, 0), 0.0, "an entrance starts at nothing");
		let midway = motion.enter(key, ENTER, 100);
		assert!(midway > 0.0 && midway < 1.0);
		assert_eq!(motion.enter(key, ENTER, 300), 1.0);

		// The frame after it finished, and a hundred frames later: still 1. It
		// asks for no more frames, and it is kept, because a value at 1 is not
		// the same as a value that was never there.
		assert!(!motion.advance(300), "an arrived entrance asked for another frame");
		assert_eq!(motion.len(), 1);
		assert_eq!(motion.enter(key, ENTER, 5_000), 1.0, "the entrance replayed");
	}

	#[test]
	fn a_hover_that_never_happened_creates_nothing() {
		// Every drawn row reports a leave when the pointer crosses the list. A
		// registry that stores a zero for each of them grows with the session
		// count and scans longer every frame.
		let mut motion = Motion::new();
		motion.flip(Key::named(Channel::Row, "a"), false, WASH, 0);
		assert!(motion.is_empty(), "a leave created a channel");
	}

	#[test]
	fn a_hover_wash_does_not_outlive_the_row_it_belonged_to() {
		// A row unmounted while the pointer is over it never gets its leave, so
		// its channel would sit at 1.0 and the row would come back lit. It is
		// dropped instead, because nothing read it for a whole frame.
		let mut motion = Motion::new();
		let key = Key::named(Channel::Row, "grep");
		motion.flip(key, true, WASH, 0);
		assert_eq!(motion.value(key, 200), 1.0);
		assert!(!motion.advance(200), "an arrived wash asked for another frame");
		assert_eq!(motion.len(), 1, "the wash was read this frame, so it stays");

		// The next frame does not draw the row at all.
		assert!(!motion.advance(400));
		assert!(motion.is_empty(), "the wash outlived its row");
		assert_eq!(motion.value(key, 400), 0.0, "the row came back lit");
	}

	#[test]
	fn a_value_settled_back_at_zero_is_forgotten() {
		let mut motion = Motion::new();
		let key = Key::named(Channel::Control, "send");
		motion.flip(key, true, WASH, 0);
		motion.value(key, 0);
		motion.advance(0);
		motion.flip(key, false, WASH, 0);
		motion.value(key, 200);
		assert!(!motion.advance(200));
		assert!(motion.is_empty(), "a settled hover was kept");
	}

	#[test]
	fn the_window_stops_asking_for_frames_once_everything_arrives() {
		// The failure this closes is a window that repaints forever for a
		// motion that ended, which is the single most expensive defect an
		// animation layer can have.
		let mut motion = Motion::new();
		let key = Key::of(Channel::SidebarWidth);
		motion.drive(key, RESIZE, 0.0, 0);
		motion.drive(key, RESIZE, 268.0, 0);
		assert_eq!(motion.next_frame_after(0), Some(0));

		let mut now = 0;
		let mut frames = 0;
		while let Some(wait) = motion.next_frame_after(now) {
			now += wait.max(16) as u64;
			motion.drive(key, RESIZE, 268.0, now);
			motion.advance(now);
			frames += 1;
			assert!(frames < 100, "the window never stopped asking for frames");
		}
		assert_eq!(motion.drive(key, RESIZE, 268.0, now), 268.0);
	}

	#[test]
	fn reduced_motion_snaps_every_value_and_schedules_no_frames() {
		let mut motion = Motion::new();
		motion.set_reduced(true);
		let key = Key::of(Channel::SidebarWidth);
		motion.drive(key, RESIZE, 0.0, 0);
		assert_eq!(motion.drive(key, RESIZE, 268.0, 0), 268.0, "a value animated");
		assert_eq!(motion.enter(Key::of(Channel::Sheet), SHEET_IN, 0), 1.0);
		assert!(!motion.advance(0));
		assert_eq!(motion.next_frame_after(0), None);
	}

	#[test]
	fn a_wash_fading_in_from_transparent_never_passes_through_grey() {
		// Naive interpolation of a white wash over transparent black darkens
		// first and brightens second, which reads as a flicker on a dark row.
		let wash = Hsla { h: 0.0, s: 0.0, l: 1.0, a: 0.08 };
		let half = mix(gpui::transparent_black(), wash, 0.5);
		close(half.a, 0.04, 1e-4, "alpha midpoint");
		let rgba = Rgba::from(half);
		assert!(rgba.r > 0.99 && rgba.g > 0.99 && rgba.b > 0.99, "the wash lost its hue: {rgba:?}");
	}

	#[test]
	fn mixing_holds_its_endpoints_and_clamps() {
		let from = Hsla { h: 0.6, s: 0.1, l: 0.2, a: 1.0 };
		let to = Hsla { h: 0.6, s: 0.1, l: 0.4, a: 1.0 };
		assert_eq!(mix(from, to, 0.0), from);
		assert_eq!(mix(from, to, 1.0), to);
		assert_eq!(mix(from, to, -1.0), from);
		assert_eq!(mix(from, to, 2.0), to);
		let middle = mix(from, to, 0.5);
		assert!(middle.l > from.l && middle.l < to.l, "midpoint lightness {}", middle.l);
	}

	#[test]
	fn a_named_key_is_stable_and_distinguishes_its_channel() {
		let row = Key::named(Channel::Row, "frame");
		assert_eq!(row, Key::named(Channel::Row, "frame"));
		assert_ne!(row, Key::named(Channel::Row, "themes"));
		assert_ne!(row, Key::named(Channel::Control, "frame"), "two channels collided");
	}
}

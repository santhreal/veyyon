//! The registry: every channel's current value, advanced once per frame.

use super::{
	Key, RESIZE, SPIN, Spec,
	blend::{env_scale, lerp},
};

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

	/// A value that runs 0 to 1 over one period and starts again, for as long as
	/// it is read.
	///
	/// The one channel that does not settle. It keeps reporting that it moves,
	/// which is what keeps the window asking for frames while something is
	/// running; the frame it stops being read, the sweep in
	/// [`Motion::advance`] drops it and the frames stop.
	///
	/// The period boundary advances `started` by whole periods rather than
	/// resetting it to `now`, so a turn that is read late does not lose the
	/// overshoot and drift against a second indicator on screen.
	///
	/// Under reduced motion this is flat at zero and asks for no frames: an
	/// indeterminate indicator is the one place where the honest alternative to
	/// spinning is standing still.
	pub fn spinning(&mut self, key: Key, now: u64) -> f32 {
		if self.reduced {
			return 0.0;
		}
		let period = (SPIN.duration_ms as f32 * self.scale) as u64;
		match self.find(key) {
			Some(index) => {
				let track = &mut self.tracks[index];
				track.touched = true;
				if period > 0 {
					let elapsed = now.saturating_sub(track.started);
					if elapsed >= period {
						track.started += (elapsed / period) * period;
					}
				}
				self.tracks[index].value(now, self.scale)
			},
			None => {
				self.tracks.push(Track {
					key,
					from: 0.0,
					to: 1.0,
					spec: SPIN,
					started: now,
					touched: true,
				});
				0.0
			},
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
	pub(super) fn len(&self) -> usize {
		self.tracks.len()
	}

	#[cfg(test)]
	pub(super) fn is_empty(&self) -> bool {
		self.tracks.is_empty()
	}
}

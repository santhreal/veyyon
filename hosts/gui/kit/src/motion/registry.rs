//! Fixed-capacity retained motion registry.
//!
//! Event methods create and retarget tracks. Frame methods only sample, mark
//! local damage, retire settled slots, and calculate the next wake. No frame
//! operation grows or constructs a collection.

use super::{
	Damage, DamageSet, FrameResult, MAX_ACTIVITY_CLIENTS, MAX_COLLECTION_GHOSTS,
	MAX_CONTINUOUS_TRACKS, MotionKey, Priority, Program, RetainedKey, Sample, Wake, index::KeyIndex,
	sample::sample,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct Track {
	pub(super) key:      MotionKey,
	pub(super) x0:       f32,
	pub(super) v0:       f32,
	pub(super) target:   f32,
	pub(super) started:  u64,
	pub(super) program:  Program,
	pub(super) damage:   Damage,
	pub(super) priority: Priority,
	pub(super) sequence: u64,
	/// Set on the frame a non-zero track settles, so the frame after it neither
	/// marks damage nor asks for a wake while it holds its target.
	pub(super) parked:   bool,
}

impl Track {
	pub(super) fn at(self, now: u64) -> Sample {
		sample(self.program, self.x0, self.v0, self.target, now.saturating_sub(self.started))
	}

	/// A track at rest carries no state a later render needs: the property's
	/// resting value is the one its caller passes to `sample`. A track holding a
	/// non-zero target does, and is the only kind that survives settlement.
	fn resting(self) -> bool {
		self.target.abs() <= f32::EPSILON
	}
}

#[derive(Debug, Clone, Copy)]
pub struct Ghost {
	pub owner:        RetainedKey,
	pub snapshot:     u64,
	pub value:        f32,
	pub(super) track: Track,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ActivityClient {
	pub(super) owner:  RetainedKey,
	pub(super) offset: u8,
	pub(super) damage: Damage,
}

pub struct Motion {
	pub(super) tracks:        [Option<Track>; MAX_CONTINUOUS_TRACKS],
	pub(super) index:         KeyIndex,
	pub(super) ghosts:        [Option<Ghost>; MAX_COLLECTION_GHOSTS],
	pub(super) activity:      [Option<ActivityClient>; MAX_ACTIVITY_CLIENTS],
	pub(super) reduced:       bool,
	pub(super) sequence:      u64,
	pub(super) damage:        DamageSet,
	pub(super) activity_step: u64,
}

impl Default for Motion {
	fn default() -> Self {
		Self::new(false)
	}
}

impl Motion {
	pub const fn new(reduced: bool) -> Self {
		Self {
			tracks: [None; MAX_CONTINUOUS_TRACKS],
			index: KeyIndex::new(),
			ghosts: [None; MAX_COLLECTION_GHOSTS],
			activity: [None; MAX_ACTIVITY_CLIENTS],
			reduced,
			sequence: 0,
			damage: DamageSet { paint: 0, layout: 0, scroll: 0 },
			activity_step: 0,
		}
	}

	pub fn set_reduced(&mut self, reduced: bool) {
		self.reduced = reduced;
		if reduced {
			self.tracks.fill(None);
			self.index.clear();
			self.ghosts.fill(None);
		}
	}

	pub const fn reduced(&self) -> bool {
		self.reduced
	}

	pub(super) fn find(&self, key: MotionKey) -> Option<usize> {
		self.index.find(key)
	}

	/// Retarget a property at event time, preserving its sampled velocity.
	///
	/// Returns false only when all 32 tracks have equal or higher priority. The
	/// caller still commits `target`; overflow therefore settles rather than
	/// allocating or dropping authoritative state.
	pub fn retarget(
		&mut self,
		key: MotionKey,
		program: Program,
		target: f32,
		now: u64,
		priority: Priority,
		damage: Damage,
	) -> bool {
		self.damage.mark(damage);
		if self.reduced || matches!(program, Program::Direct) {
			if let Some(index) = self.find(key) {
				self.tracks[index] = None;
				self.index.remove(key);
			}
			return true;
		}
		if let Some(index) = self.find(key) {
			let current = self.event_sample(index, now);
			self.sequence = self.sequence.wrapping_add(1);
			self.tracks[index] = Some(Track {
				key,
				x0: current.value,
				v0: current.velocity,
				target,
				started: now,
				program,
				damage,
				priority,
				sequence: self.sequence,
				parked: false,
			});
			return true;
		}
		if target.abs() <= f32::EPSILON {
			return true;
		}
		self.sequence = self.sequence.wrapping_add(1);
		self.insert_track(Track {
			key,
			x0: 0.0,
			v0: 0.0,
			target,
			started: now,
			program,
			damage,
			priority,
			sequence: self.sequence,
			parked: false,
		})
	}

	/// Register a real model insertion. This is never called by render.
	///
	/// Eight arguments, each a distinct fact the caller already holds: the
	/// track's identity, its program, where it is, where it is going, when, how
	/// it ranks and what it dirties. A struct around them would be built at
	/// every call site and destructured here.
	#[allow(clippy::too_many_arguments)]
	pub fn insert(
		&mut self,
		key: MotionKey,
		program: Program,
		from: f32,
		target: f32,
		now: u64,
		priority: Priority,
		damage: Damage,
	) -> bool {
		self.damage.mark(damage);
		if self.reduced {
			return true;
		}
		self.sequence = self.sequence.wrapping_add(1);
		self.insert_track(Track {
			key,
			x0: from,
			v0: 0.0,
			target,
			started: now,
			program,
			damage,
			priority,
			sequence: self.sequence,
			parked: false,
		})
	}

	fn insert_track(&mut self, track: Track) -> bool {
		if let Some(index) = self.tracks.iter().position(Option::is_none) {
			self.tracks[index] = Some(track);
			return self.index.insert(track.key, index);
		}
		let candidate = self
			.tracks
			.iter()
			.enumerate()
			.filter_map(|(index, slot)| slot.map(|item| (index, item)))
			.filter(|(_, item)| item.priority < track.priority)
			.min_by_key(|(_, item)| (item.priority, item.sequence));
		if let Some((index, previous)) = candidate {
			self.index.remove(previous.key);
			self.tracks[index] = Some(track);
			self.index.insert(track.key, index)
		} else {
			false
		}
	}

	/// Retain one bounded paint snapshot for collection or overlay exit.
	pub fn remove(
		&mut self,
		owner: RetainedKey,
		snapshot: u64,
		key: MotionKey,
		program: Program,
		now: u64,
		damage: Damage,
	) -> bool {
		if self.reduced {
			return true;
		}
		let Some(slot) = self.ghosts.iter_mut().find(|slot| slot.is_none()) else {
			return false;
		};
		let track = Track {
			key,
			x0: 1.0,
			v0: 0.0,
			target: 0.0,
			started: now,
			program,
			damage,
			priority: Priority::Content,
			sequence: self.sequence,
			parked: false,
		};
		*slot = Some(Ghost { owner, snapshot, value: 1.0, track });
		self.damage.mark(damage);
		true
	}

	pub fn ghosts(&self) -> impl Iterator<Item = &Ghost> {
		self.ghosts.iter().flatten()
	}

	/// End one frame. Settlement and ghost retirement happen before the result
	/// is returned, so the committing frame contains no expired snapshot.
	pub fn finish_frame(&mut self, now: u64) -> FrameResult {
		let mut continuous = false;
		for index in 0..self.tracks.len() {
			let Some(track) = self.tracks[index] else {
				continue;
			};
			if track.parked {
				continue;
			}
			let current = track.at(now);
			self.damage.mark(track.damage);
			if !current.settled {
				continuous = true;
				continue;
			}
			if track.resting() {
				self.tracks[index] = None;
				self.index.remove(track.key);
			} else {
				self.tracks[index] = Some(Track { parked: true, ..track });
			}
		}
		for slot in &mut self.ghosts {
			let Some(mut ghost) = *slot else { continue };
			let current = ghost.track.at(now);
			self.damage.mark(ghost.track.damage);
			if current.settled {
				*slot = None;
			} else {
				ghost.value = current.value;
				*slot = Some(ghost);
				continuous = true;
			}
		}
		let activity_step = now / 200;
		if activity_step != self.activity_step {
			for client in self.activity.iter().flatten() {
				self.damage.mark(client.damage);
			}
			self.activity_step = activity_step;
		}
		let wake = if self.reduced {
			Wake::None
		} else if continuous {
			Wake::NextVsync
		} else if self.activity.iter().any(Option::is_some) {
			Wake::At((now / 200 + 1) * 200)
		} else {
			Wake::None
		};
		let damage = self.damage;
		self.damage = DamageSet::default();
		FrameResult { wake, damage }
	}

	pub fn cancel_owner(&mut self, owner: RetainedKey) {
		for index in 0..self.tracks.len() {
			if let Some(track) = self.tracks[index].filter(|track| track.key.owner == owner) {
				self.tracks[index] = None;
				self.index.remove(track.key);
			}
		}
		self.unregister_activity(owner);
	}

	pub fn active_tracks(&self) -> usize {
		self.tracks.iter().flatten().count()
	}

	pub fn active_ghosts(&self) -> usize {
		self.ghosts.iter().flatten().count()
	}

	pub fn activity_clients(&self) -> usize {
		self.activity.iter().flatten().count()
	}
}

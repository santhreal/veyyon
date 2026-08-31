//! Retained motion identities, programs, damage, and frame wake results.
//!
//! Callers assign one [`RetainedKey`] per model object. A real removal advances
//! its generation before the numeric object id can be reused. Rendering samples
//! existing tracks; insert, remove, reorder, drag, and retarget happen on
//! events.

use super::Curve;

pub const MAX_CONTINUOUS_TRACKS: usize = 32;
pub const MAX_COLLECTION_GHOSTS: usize = 12;
pub const MAX_ACTIVITY_CLIENTS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum OwnerNamespace {
	Shell = 1,
	Conversation,
	Changes,
	Files,
	Terminal,
	Agents,
	Settings,
	Overlays,
	Render,
	Kit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RetainedKey {
	pub object:     u64,
	pub generation: u32,
}

impl RetainedKey {
	pub const fn new(object: u64, generation: u32) -> Self {
		Self { object, generation }
	}

	/// Collision-free feature scope for numeric model and static control ids.
	///
	/// The namespace occupies the high byte. Product ids use the low 56 bits;
	/// callers reject ids outside that range rather than truncating them.
	pub const fn scoped(namespace: OwnerNamespace, local: u64, generation: u32) -> Option<Self> {
		if local > 0x00ff_ffff_ffff_ffff {
			return None;
		}
		Some(Self { object: ((namespace as u64) << 56) | local, generation })
	}

	pub const fn semantic(namespace: OwnerNamespace, local: u32) -> Self {
		Self { object: ((namespace as u64) << 56) | local as u64, generation: 0 }
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Property {
	Opacity,
	TranslateX,
	TranslateY,
	Scale,
	Width,
	Height,
	ColorMix,
	Rotation,
	ScrollOffset,
	ActivityPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MotionKey {
	pub owner:    RetainedKey,
	pub property: Property,
}

impl MotionKey {
	pub const fn new(owner: RetainedKey, property: Property) -> Self {
		Self { owner, property }
	}
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spring {
	pub omega:            f32,
	pub damping_ratio:    f32,
	pub epsilon_value:    f32,
	pub epsilon_velocity: f32,
	pub hard_limit_ms:    u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tween {
	pub duration_ms: u16,
	pub curve:       Curve,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Steps {
	pub count:      u8,
	pub period_ms:  u16,
	pub rest_steps: u8,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Program {
	Spring(Spring),
	Tween(Tween),
	Steps(Steps),
	Direct,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
	pub value:    f32,
	pub velocity: f32,
	pub settled:  bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
	Decorative,
	Content,
	Selected,
	Focused,
	Drag,
	Shell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Damage {
	None,
	Paint(u8),
	Layout(u8),
	Scroll(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DamageSet {
	pub paint:  u64,
	pub layout: u64,
	pub scroll: u64,
}

impl DamageSet {
	pub fn mark(&mut self, damage: Damage) {
		let (set, root) = match damage {
			Damage::None => return,
			Damage::Paint(root) => (&mut self.paint, root),
			Damage::Layout(root) => (&mut self.layout, root),
			Damage::Scroll(root) => (&mut self.scroll, root),
		};
		if root < 64 {
			*set |= 1_u64 << root;
		}
	}

	pub const fn is_empty(self) -> bool {
		self.paint == 0 && self.layout == 0 && self.scroll == 0
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
	None,
	NextVsync,
	At(u64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameResult {
	pub wake:   Wake,
	pub damage: DamageSet,
}

/// Generation storage for callers that recycle numeric ids.
///
/// The table is fixed so creation and retirement do not allocate. A full table
/// rejects a new owner rather than reusing a live generation.
pub struct OwnerGenerations<const N: usize> {
	slots: [Option<(u64, u32)>; N],
}

impl<const N: usize> Default for OwnerGenerations<N> {
	fn default() -> Self {
		Self { slots: [None; N] }
	}
}

impl<const N: usize> OwnerGenerations<N> {
	pub fn current(&mut self, object: u64) -> Option<RetainedKey> {
		if let Some((_, generation)) = self.slots.iter().flatten().find(|(id, _)| *id == object) {
			return Some(RetainedKey::new(object, *generation));
		}
		let slot = self.slots.iter_mut().find(|slot| slot.is_none())?;
		*slot = Some((object, 0));
		Some(RetainedKey::new(object, 0))
	}

	pub fn retire(&mut self, key: RetainedKey) -> bool {
		let Some(slot) = self
			.slots
			.iter_mut()
			.find(|slot| matches!(slot, Some((id, generation)) if *id == key.object && *generation == key.generation))
		else {
			return false;
		};
		if let Some((_, generation)) = slot {
			*generation = generation.wrapping_add(1);
		}
		true
	}
}

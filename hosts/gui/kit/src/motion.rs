//! Retained, bounded, event-driven motion.
//!
//! Model events call [`Motion::insert`], [`Motion::retarget`],
//! [`Motion::remove`], or [`Motion::set_direct`]. Rendering calls
//! [`Motion::sample`] with a settled endpoint and never registers an entrance.
//! [`Motion::finish_frame`] retires settled work in the committing frame and
//! returns the only permitted motion wake. The registry contains 32 continuous
//! tracks, 12 collection ghosts, and 8 clients of one stepped activity clock.
//!
//! Spring samples are analytic and carry position and velocity across a
//! retarget. The frame loop performs no collection allocation. Reduced motion
//! clears spatial work, snaps every endpoint, and returns no motion wake.

mod blend;
mod collection;
mod curve;
mod eval;
mod index;
mod model;
mod owners;
mod registry;
mod sample;
pub mod spec;

pub use blend::{lerp, mix};
pub use collection::{CollectionChange, CollectionItem, CollectionPlan};
pub use curve::{COLOR, Curve, EASE, EXPO_OUT, IN, IN_OUT, LINEAR, OUT};
pub use model::{
	Damage, DamageSet, FrameResult, MAX_ACTIVITY_CLIENTS, MAX_COLLECTION_GHOSTS,
	MAX_CONTINUOUS_TRACKS, MotionKey, OwnerGenerations, OwnerNamespace, Priority, Program, Property,
	RetainedKey, Sample, Spring, Steps, Tween, Wake,
};
pub use owners::{BLOCK, control, owner, owner_at};
pub use registry::{Ghost, Motion};
pub use sample::{sample, sample_spring, sample_tween};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod two_names_never_share_one_track;

//! Retained renderer boundary for the Output tab.
//!
//! Large output histories are reconciled into one retained text/display object;
//! the GPUI tree contains one viewport rather than one element per line.
use std::collections::BTreeSet;

use gpui::{AnyElement, App};
use veyyon_gui_core::model::{OutputLevel, OutputRecord, Versioned};
/// Edge-triggered frame state shared with terminal arrival.
///
/// The first record schedules the next window frame; further records before
/// that frame return `FrameRequest::Coalesced`.
pub type OutputFrameCoalescer = crate::terminal::FrameCoalescer;

/// Fixed filter bits passed without building a per-frame channel collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputLevelMask(u8);

impl OutputLevelMask {
	pub fn from_enabled(levels: &BTreeSet<OutputLevel>) -> Self {
		if levels.is_empty() {
			return Self(0b1111);
		}
		let mut bits = 0;
		for level in levels {
			bits |= match level {
				OutputLevel::Trace => 0b0001,
				OutputLevel::Info => 0b0010,
				OutputLevel::Warning => 0b0100,
				OutputLevel::Error => 0b1000,
			};
		}
		Self(bits)
	}

	pub fn includes(self, level: OutputLevel) -> bool {
		let bit = match level {
			OutputLevel::Trace => 0b0001,
			OutputLevel::Info => 0b0010,
			OutputLevel::Warning => 0b0100,
			OutputLevel::Error => 0b1000,
		};
		self.0 & bit != 0
	}
}

/// Retained channel totals updated during reconciliation, never by scanning the
/// full buffer during view construction.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct OutputChannelCounts {
	pub records:    usize,
	pub notices:    usize,
	pub processes:  usize,
	pub tools:      usize,
	pub extensions: usize,
	pub agents:     usize,
	pub transcript: usize,
}

/// Output viewport preferences owned by frontend navigation state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputViewportState {
	pub paused: bool,
	pub wrap:   bool,
	pub stale:  bool,
	pub levels: OutputLevelMask,
}

/// Adapter implemented by a retained output text renderer.
pub trait OutputRendererAdapter {
	/// Reconcile engine records by stable replica revision.
	///
	/// Implementations may append when the revision advances, but must replace
	/// their retained buffer when the producer supplies a non-prefix snapshot.
	fn reconcile(&mut self, output: &Versioned<Vec<OutputRecord>>);
	fn channel_counts(&self) -> OutputChannelCounts;

	fn selection(&self) -> Option<&str>;
	fn clear_selection(&mut self);
	/// Whether new records currently keep the viewport pinned to the tail.
	///
	/// Implementations cancel this in the same wheel or selection event; they
	/// do not wait for a later frame.
	fn is_following_tail(&self) -> bool;
	fn viewport(&mut self, state: OutputViewportState, cx: &mut App) -> AnyElement;
}

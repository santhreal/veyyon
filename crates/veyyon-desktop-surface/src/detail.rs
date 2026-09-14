//! The detail a row states when there is no room to draw it (§5.6, §8.25).
//!
//! Three surfaces cut what they know: the workspace tree draws a file's name
//! inside a panel narrower than its path, the composer's footer draws a
//! model's display name and none of what the catalog says about it, and a
//! hunk header draws ranges and a truncated symbol inside a pane that has
//! scrolled its file's own header away. Each of them has the rest in the
//! state already, and nowhere to put it.
//!
//! One anchored popover answers all three. What it says is derived here as
//! facts, in a function with no element in it, so the sweep that requires
//! every source to state something reads the same values the frame draws.
//! It is window-local, like a hover: the state carries no record of it, so a
//! snapshot from the host never reopens a popover the operator dismissed.

mod facts;
mod layer;

pub use facts::{DetailFacts, DetailRow, detail_facts};
pub use layer::detail_layer;
use veyyon_desktop_kit::AnchorCorner;
use veyyon_gpui::{Pixels, Point};

/// Which surface a detail popover was opened from.
///
/// Carried apart from the payload so a sweep can enumerate the sources the
/// build offers without inventing a payload for each: a new `DetailKind`
/// without a source here does not compile, and a source with no fixture to
/// open it turns the sweep red.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, strum::EnumIter)]
pub enum DetailSource {
	/// A file or directory row in the workspace tree.
	TreeRow,
	/// The model the composer sends the next turn to.
	Model,
	/// One hunk of one changed file in the diff pane.
	DiffHunk,
}

/// What a detail popover was opened on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetailKind {
	/// The workspace tree row at this path.
	TreeRow(String),
	/// The model in effect for the open session.
	Model,
	/// The hunk header at this row index of this file's rows.
	DiffHunk { path: String, row: usize },
}

impl DetailKind {
	/// The surface this detail was opened from.
	#[must_use]
	pub const fn source(&self) -> DetailSource {
		match self {
			Self::TreeRow(_) => DetailSource::TreeRow,
			Self::Model => DetailSource::Model,
			Self::DiffHunk { .. } => DetailSource::DiffHunk,
		}
	}
}

/// A detail popover that is open: what it was opened on, where the control it
/// belongs to is, and which corner of itself sits at that point before any
/// flip a window edge forces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detail {
	pub kind:   DetailKind,
	pub origin: Point<Pixels>,
	pub anchor: AnchorCorner,
}

impl Detail {
	/// Opens a detail at a point, growing right and down from it.
	#[must_use]
	pub const fn below(kind: DetailKind, origin: Point<Pixels>) -> Self {
		Self { kind, origin, anchor: AnchorCorner::TopLeft }
	}

	/// Opens a detail at a point, growing right and up from it, which is what
	/// a control at the bottom of the window wants.
	#[must_use]
	pub const fn above(kind: DetailKind, origin: Point<Pixels>) -> Self {
		Self { kind, origin, anchor: AnchorCorner::BottomLeft }
	}
}

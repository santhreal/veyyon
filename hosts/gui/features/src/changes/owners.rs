//! One name per object the changes surfaces draw, and one place that states it.
//!
//! The route toolbar, the sidebar tree, and the inspector all draw out of
//! [`OwnerNamespace::Changes`] at the same time. Each used to pick its own
//! numbers - the sidebar took 110 and 201, the toolbar 1 through 40, the
//! inspector 100 through 121, and the tree counted upward from 1 - so a tree
//! row drew on the same track as a toolbar control. Names replace the numbers,
//! and `kit::motion::owners` hands out one block of ids per name.

use veyyon_gui_core::model::{AttachmentId, ChangeScope, FileId};
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, control, owner};

const NS: OwnerNamespace = OwnerNamespace::Changes;

/// What each sort of object is, in the namespace's table of names.
const CHROME: &str = "chrome";
const SCOPE: &str = "scope";
const FOLDER: &str = "folder";
const FILE: &str = "file";
const COMMENT: &str = "comment";

/// Every fixed control the changes route, sidebar, and inspector draw. One
/// variant per control, so two controls cannot be given one name by mistake.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chrome {
	Attach,
	Spinner,
	RetryConnection,
	LayoutUnified,
	LayoutSplit,
	Refresh,
	Base,
	Search,
	TreeMode,
	ListMode,
	OpenFile,
	RevealFile,
	CopyPath,
	Wrap,
	Whitespace,
	PreviousHunk,
	NextHunk,
}

impl Chrome {
	/// Every variant, for the suite that sweeps them. Drawing code names one
	/// control at a time, so nothing outside a test reads the whole set.
	#[cfg(test)]
	pub const ALL: [Chrome; 17] = [
		Chrome::Attach,
		Chrome::Spinner,
		Chrome::RetryConnection,
		Chrome::LayoutUnified,
		Chrome::LayoutSplit,
		Chrome::Refresh,
		Chrome::Base,
		Chrome::Search,
		Chrome::TreeMode,
		Chrome::ListMode,
		Chrome::OpenFile,
		Chrome::RevealFile,
		Chrome::CopyPath,
		Chrome::Wrap,
		Chrome::Whitespace,
		Chrome::PreviousHunk,
		Chrome::NextHunk,
	];

	pub const fn name(self) -> &'static str {
		match self {
			Chrome::Attach => "attach",
			Chrome::Spinner => "spinner",
			Chrome::RetryConnection => "retry-connection",
			Chrome::LayoutUnified => "layout-unified",
			Chrome::LayoutSplit => "layout-split",
			Chrome::Refresh => "refresh",
			Chrome::Base => "base",
			Chrome::Search => "search",
			Chrome::TreeMode => "tree-mode",
			Chrome::ListMode => "list-mode",
			Chrome::OpenFile => "open-file",
			Chrome::RevealFile => "reveal-file",
			Chrome::CopyPath => "copy-path",
			Chrome::Wrap => "wrap",
			Chrome::Whitespace => "whitespace",
			Chrome::PreviousHunk => "previous-hunk",
			Chrome::NextHunk => "next-hunk",
		}
	}
}

/// A control drawn against one file row, and its offset inside the row's block.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RowSlot {
	Open   = 1,
	Reveal = 2,
	Copy   = 3,
}

impl RowSlot {
	/// Every variant, for the suite that sweeps them. Drawing code names one
	/// control at a time, so nothing outside a test reads the whole set.
	#[cfg(test)]
	pub const ALL: [RowSlot; 3] = [RowSlot::Open, RowSlot::Reveal, RowSlot::Copy];

	pub const fn offset(self) -> u8 {
		self as u8
	}
}

/// The track a fixed control animates on.
pub fn chrome(control: Chrome) -> RetainedKey {
	owner(NS, CHROME, control.name())
}

/// The track a scope tab animates on. Keyed by the scope's kind, not its
/// position in the strip, so a scope appearing or leaving does not move the
/// tabs beside it.
pub fn scope(scope: &ChangeScope) -> RetainedKey {
	owner(NS, SCOPE, match scope {
		ChangeScope::WorkingTree => "working-tree",
		ChangeScope::Session => "session",
		ChangeScope::Entry(_) => "entry",
		ChangeScope::Custom(_) => "custom",
	})
}

/// The track this folder row animates on.
pub fn folder(path: &str) -> RetainedKey {
	owner(NS, FOLDER, path)
}

/// The track this file row animates on.
pub fn file(id: &FileId) -> RetainedKey {
	owner(NS, FILE, id.as_str())
}

/// The track a file row's `slot` control animates on, inside the row's block.
pub fn file_control(id: &FileId, slot: RowSlot) -> RetainedKey {
	control(NS, FILE, id.as_str(), slot.offset())
}

/// The track a pending review comment's control animates on. Keyed by the
/// attachment, so removing the comment above it does not move it.
pub fn comment(id: &AttachmentId) -> RetainedKey {
	owner(NS, COMMENT, id.as_str())
}

/// The track a row whose file the snapshot no longer holds animates on. Such
/// rows share it, which is what the reserved id is for: a row with no object
/// behind it has no identity to key on.
pub fn missing() -> RetainedKey {
	RetainedKey::reserved(NS)
}

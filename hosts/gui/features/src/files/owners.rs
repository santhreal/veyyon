//! One name per object the files surfaces draw, and one place that states it.
//!
//! The tree, its header, the inspector, the error states, and the search list
//! all draw out of [`OwnerNamespace::Files`] at the same time. Each used to
//! pick its own numbers - the tree took 1 through 12, the header 30 through 34,
//! the error states 35 through 37, the inspector 20 and 21 - while the tree
//! cache counted rows upward from 1 and the outline from 1000, so a tree row
//! drew on the same track as a header button. Names replace the numbers, and
//! `kit::motion::owners` hands out one block of ids per name.

use veyyon_gui_core::model::{FileId, WorkspaceId};
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, owner, owner_at};

const NS: OwnerNamespace = OwnerNamespace::Files;

/// What each sort of object is, in the namespace's table of names.
const CHROME: &str = "chrome";
const FILE: &str = "file";
const WORKSPACE: &str = "workspace";
const AUX: &str = "aux";
const SEARCH: &str = "search";
const OUTLINE: &str = "outline";

/// Every fixed control the files surfaces draw. One variant per control, so two
/// controls cannot be given one name by mistake.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chrome {
	RefreshTree,
	SearchFiles,
	Filter,
	TabNames,
	TabContents,
	RefreshSelected,
	RevealSelected,
	CopyPath,
	CopyContents,
	OpenExternal,
	StateAction,
	LoadingPrimary,
	LoadingSecondary,
	MentionFile,
	AttachLines,
}

impl Chrome {
	/// Every variant, for the suite that sweeps them. Drawing code names one
	/// control at a time, so nothing outside a test reads the whole set.
	#[cfg(test)]
	pub const ALL: [Chrome; 15] = [
		Chrome::RefreshTree,
		Chrome::SearchFiles,
		Chrome::Filter,
		Chrome::TabNames,
		Chrome::TabContents,
		Chrome::RefreshSelected,
		Chrome::RevealSelected,
		Chrome::CopyPath,
		Chrome::CopyContents,
		Chrome::OpenExternal,
		Chrome::StateAction,
		Chrome::LoadingPrimary,
		Chrome::LoadingSecondary,
		Chrome::MentionFile,
		Chrome::AttachLines,
	];

	pub const fn name(self) -> &'static str {
		match self {
			Chrome::RefreshTree => "refresh-tree",
			Chrome::SearchFiles => "search-files",
			Chrome::Filter => "filter",
			Chrome::TabNames => "tab-names",
			Chrome::TabContents => "tab-contents",
			Chrome::RefreshSelected => "refresh-selected",
			Chrome::RevealSelected => "reveal-selected",
			Chrome::CopyPath => "copy-path",
			Chrome::CopyContents => "copy-contents",
			Chrome::OpenExternal => "open-external",
			Chrome::StateAction => "state-action",
			Chrome::LoadingPrimary => "loading-primary",
			Chrome::LoadingSecondary => "loading-secondary",
			Chrome::MentionFile => "mention-file",
			Chrome::AttachLines => "attach-lines",
		}
	}
}

/// The track a fixed control animates on.
pub fn chrome(control: Chrome) -> RetainedKey {
	owner(NS, CHROME, control.name())
}

/// The track this file's tree row animates on.
pub fn file(id: &FileId) -> RetainedKey {
	owner(NS, FILE, id.as_str())
}

/// The track this workspace's root row animates on.
pub fn workspace(id: &WorkspaceId) -> RetainedKey {
	owner(NS, WORKSPACE, id.as_str())
}

/// The track a placeholder row - loading, empty, unreadable - animates on. The
/// caller names the row, and the name carries the parent it belongs to.
pub fn aux(name: &str) -> RetainedKey {
	owner(NS, AUX, name)
}

/// The track a search hit animates on. Keyed by file and line, so a hit keeps
/// its track as the query narrows the list around it. A hit with no line is the
/// file itself, which is why the line is held one above zero.
pub fn search_hit(file: &FileId, line: Option<u32>) -> RetainedKey {
	let at = line.map_or(0, |line| u64::from(line).saturating_add(1));
	owner_at(NS, SEARCH, file.as_str(), at)
}

/// The track an outline row animates on, keyed by the range it covers.
pub fn outline(file: &FileId, start: u32, end: u32) -> RetainedKey {
	let at = (u64::from(start) << 32) | u64::from(end);
	owner_at(NS, OUTLINE, file.as_str(), at)
}

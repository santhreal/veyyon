//! WHY. The files tree, its header, its inspector, and its error states each
//! picked their own numbers out of one namespace: the tree took 1 through 12,
//! the inspector 20 and 21, the header 30 through 34, the error states 35
//! through 37, while the tree cache handed rows ids counting upward from 1 and
//! the outline from 1000. A tree row therefore drew on the same track as the
//! tree's own refresh button, and an outline row on the same track as a header
//! button.
//!
//! THE CLASS. Two objects a window can draw at the same time resolving to one
//! [`RetainedKey`]. Every object is named through `kit::motion::owners`, and
//! this suite sweeps the names: the whole of [`Chrome::ALL`], workspace roots,
//! file rows, placeholder rows, search hits, and outline ranges. A new control
//! cannot be added quietly - `every_control_is_named` matches the enum
//! exhaustively, so a new variant fails to build until it is named and listed.
//!
//! WHAT IT DOES NOT CATCH. Objects in other namespaces, which
//! `kit/src/motion/two_names_never_share_one_track.rs` covers generically, and
//! the reader's own line rows, which carry element ids and no retained key. It
//! also does not catch which table a sort of object is filed under: moving the
//! controls from `chrome` to `outline` keeps every key distinct, because an
//! outline id always carries a range and a control name never does. The tables
//! separate names that could read alike, not keys that would collide.

use std::collections::{BTreeSet, HashSet};

use veyyon_gui_core::model::{FileId, WorkspaceId};
use veyyon_gui_kit::motion::RetainedKey;

use super::owners::{self, Chrome};

fn file_of(id: &str) -> FileId {
	FileId::new(id).expect("the fixture ids are valid")
}

fn workspace_of(id: &str) -> WorkspaceId {
	WorkspaceId::new(id).expect("the fixture ids are valid")
}

/// Every control is named, one variant at a time. The match is exhaustive and
/// has no wildcard, so a new control fails to build until it is named here and
/// added to [`Chrome::ALL`], which the sweeps below read.
#[test]
fn every_control_is_named() {
	let names: BTreeSet<&'static str> = Chrome::ALL.iter().map(|control| control.name()).collect();
	assert_eq!(names.len(), Chrome::ALL.len(), "two controls share one name");
	for control in Chrome::ALL {
		let expected = match control {
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
		};
		assert_eq!(control.name(), expected, "{control:?} was renamed");
	}
}

/// Every object the tree, the header, the inspector, and the search list draw
/// at once, swept against every other.
#[test]
fn no_two_objects_the_route_draws_share_a_track() {
	let mut seen: HashSet<RetainedKey> = HashSet::new();
	for control in Chrome::ALL {
		assert!(seen.insert(owners::chrome(control)), "{control:?} shares a track");
	}
	for id in ["workspace-a", "workspace-b"] {
		assert!(
			seen.insert(owners::workspace(&workspace_of(id))),
			"the root row {id} shares a track"
		);
	}
	for path in ["src", "src/main.rs", "src/lib.rs"] {
		assert!(seen.insert(owners::file(&file_of(path))), "the row {path} shares a track");
	}
	for name in ["loading-src", "empty-src", "error-src"] {
		assert!(seen.insert(owners::aux(name)), "the placeholder row {name} shares a track");
	}
	let hit = file_of("src/main.rs");
	assert!(seen.insert(owners::search_hit(&hit, Some(12))), "a search hit shares a track");
	assert!(seen.insert(owners::search_hit(&hit, Some(48))), "two hits in one file share a track");
	assert!(seen.insert(owners::search_hit(&hit, None)), "a whole-file hit shares a track");
	assert!(seen.insert(owners::search_hit(&hit, Some(0))), "a hit on the first line is the whole file");
	assert!(seen.insert(owners::outline(&hit, 1, 20)), "an outline row shares a track");
	assert!(seen.insert(owners::outline(&hit, 21, 40)), "two outline ranges share a track");
	assert!(seen.insert(owners::outline(&hit, 0, 1)), "an outline row at the top shares a track");
	assert!(seen.insert(owners::outline(&hit, 1, 0)), "two ranges of one span share a track");
}

/// A file row and a search hit in the same file are different objects drawn on
/// different surfaces, so a file's row key never doubles as its hit key.
#[test]
fn a_search_hit_is_not_its_file_row() {
	let file = file_of("src/main.rs");
	assert_ne!(owners::file(&file), owners::search_hit(&file, None), "a whole-file hit is the row");
	assert_ne!(owners::file(&file), owners::search_hit(&file, Some(3)), "a line hit is the row");
	assert_ne!(
		owners::file(&file),
		owners::outline(&file, 1, 9),
		"an outline range is the file's row"
	);
}

/// A row keeps its track while the rows around it come and go, which is what
/// expanding a folder or typing into the filter does.
#[test]
fn a_row_keeps_its_track_while_its_neighbours_change() {
	let file = file_of("src/main.rs");
	let workspace = workspace_of("workspace-a");
	let hit = owners::search_hit(&file, Some(12));
	let (row, root, outline) =
		(owners::file(&file), owners::workspace(&workspace), owners::outline(&file, 1, 20));
	for path in ["src/lib.rs", "src/other.rs", "tests/mod.rs"] {
		let other = file_of(path);
		let _ = owners::file(&other);
		let _ = owners::search_hit(&other, Some(1));
		let _ = owners::outline(&other, 1, 20);
	}
	let _ = owners::workspace(&workspace_of("workspace-b"));
	let _ = owners::aux("loading-src");
	assert_eq!(owners::file(&file), row, "a file row changed track");
	assert_eq!(owners::workspace(&workspace), root, "a workspace root changed track");
	assert_eq!(owners::search_hit(&file, Some(12)), hit, "a search hit changed track");
	assert_eq!(owners::outline(&file, 1, 20), outline, "an outline row changed track");
}

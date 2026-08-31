//! WHY. The changes route, its sidebar tree, and its inspector each picked
//! their own numbers out of one namespace: the sidebar took 110 for its filter
//! field and 201/202 for its mode tabs, the inspector took 100 through 121, the
//! toolbar 1 through 40, and the tree counted rows upward from 1. A tree row
//! and a toolbar control therefore resolved to one [`RetainedKey`], and the
//! inspector's review-comment control was keyed by the comment's position, so
//! removing the comment above it moved it onto its neighbour's track.
//!
//! THE CLASS. Two objects a window can draw at the same time resolving to one
//! key, and an object keyed by where it sits rather than what it is. Every
//! object is named through `kit::motion::owners`, and this suite sweeps the
//! names: the whole of [`Chrome::ALL`], every [`ChangeScope`] kind, folder
//! rows, file rows, every control in [`RowSlot::ALL`], and review comments. A
//! new control cannot be added quietly - `every_control_is_named` matches the
//! enum exhaustively, so a new variant fails to build until it is named and
//! listed.
//!
//! WHAT IT DOES NOT CATCH. Objects in other namespaces, which
//! `kit/src/motion/two_names_never_share_one_track.rs` covers generically. Rows
//! whose file the snapshot no longer holds share [`owners::missing`] by
//! construction, which the last test records rather than forbids.

use std::collections::{BTreeSet, HashSet};

use veyyon_gui_core::model::{AttachmentId, ChangeScope, EntryId, FileId};
use veyyon_gui_kit::motion::{BLOCK, RetainedKey};

use super::owners::{self, Chrome, RowSlot};

fn file_of(id: &str) -> FileId {
	FileId::new(id).expect("the fixture ids are valid")
}

fn attachment_of(id: &str) -> AttachmentId {
	AttachmentId::new(id).expect("the fixture ids are valid")
}

/// The product id inside a key: the namespace occupies the high byte.
fn local_id(key: RetainedKey) -> u64 {
	key.object & 0x00ff_ffff_ffff_ffff
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
		};
		assert_eq!(control.name(), expected, "{control:?} was renamed");
	}
}

/// A row control's offset stays inside the row's block, so it cannot reach the
/// next file's row.
#[test]
fn no_row_control_reaches_out_of_its_row() {
	let offsets: BTreeSet<u8> = RowSlot::ALL.iter().map(|slot| slot.offset()).collect();
	assert_eq!(offsets.len(), RowSlot::ALL.len(), "two row controls claim one offset");
	for slot in RowSlot::ALL {
		assert!(
			slot.offset() > 0 && u64::from(slot.offset()) < BLOCK,
			"{slot:?} sits outside the row's block of {BLOCK}"
		);
	}
	let first = file_of("src/main.rs");
	let second = file_of("src/lib.rs");
	let block = local_id(owners::file(&first));
	for slot in RowSlot::ALL {
		assert_eq!(
			local_id(owners::file_control(&first, slot)),
			block + u64::from(slot.offset()),
			"{slot:?} left its row's block"
		);
		assert_ne!(
			owners::file_control(&first, slot),
			owners::file(&second),
			"{slot:?} reached the next file's row"
		);
	}
}

/// A scope tab is keyed by the scope's kind, so the strip does not renumber
/// when a scope appears or leaves, and two kinds never share a tab's track.
#[test]
fn every_scope_kind_keeps_its_own_track() {
	let entry = EntryId::new("entry-1").expect("the fixture id is valid");
	let scopes = [
		ChangeScope::WorkingTree,
		ChangeScope::Session,
		ChangeScope::Entry(entry.clone()),
		ChangeScope::Custom("origin/main".to_owned()),
	];
	let keys: HashSet<RetainedKey> = scopes.iter().map(owners::scope).collect();
	assert_eq!(keys.len(), scopes.len(), "two scope kinds share a tab track");
	assert_eq!(
		owners::scope(&ChangeScope::Entry(entry)),
		owners::scope(&ChangeScope::Entry(EntryId::new("entry-2").expect("the fixture id is valid"))),
		"a scope tab is keyed by its kind, not by the entry it points at"
	);
}

/// Every object the route, the sidebar, and the inspector draw at once, swept
/// against every other: controls, scope tabs, folder rows, file rows, row
/// controls, and review comments.
#[test]
fn no_two_objects_the_route_draws_share_a_track() {
	let mut seen: HashSet<RetainedKey> = HashSet::new();
	for control in Chrome::ALL {
		assert!(seen.insert(owners::chrome(control)), "{control:?} shares a track");
	}
	for scope in [
		ChangeScope::WorkingTree,
		ChangeScope::Session,
		ChangeScope::Entry(EntryId::new("entry-1").expect("the fixture id is valid")),
		ChangeScope::Custom("origin/main".to_owned()),
	] {
		assert!(seen.insert(owners::scope(&scope)), "the {scope:?} tab shares a track");
	}
	for path in ["src", "src/model", "tests"] {
		assert!(seen.insert(owners::folder(path)), "the folder row {path} shares a track");
	}
	for path in ["src/main.rs", "src/lib.rs", "tests/mod.rs"] {
		let file = file_of(path);
		assert!(seen.insert(owners::file(&file)), "the file row {path} shares a track");
		for slot in RowSlot::ALL {
			assert!(
				seen.insert(owners::file_control(&file, slot)),
				"{slot:?} of {path} shares a track"
			);
		}
	}
	for id in ["comment-1", "comment-2"] {
		assert!(
			seen.insert(owners::comment(&attachment_of(id))),
			"the review comment {id} shares a track"
		);
	}
}

/// A row keeps its track while the rows around it come and go, which is what a
/// filter typing through the tree does.
#[test]
fn a_row_keeps_its_track_while_its_neighbours_change() {
	let file = file_of("src/main.rs");
	let folder = "src/model";
	let comment = attachment_of("comment-2");
	let (row, tree, review) =
		(owners::file(&file), owners::folder(folder), owners::comment(&comment));
	for other in ["src/lib.rs", "src/other.rs", "tests/mod.rs"] {
		let _ = owners::file(&file_of(other));
		let _ = owners::folder(other);
	}
	let _ = owners::comment(&attachment_of("comment-1"));
	assert_eq!(owners::file(&file), row, "a file row changed track");
	assert_eq!(owners::folder(folder), tree, "a folder row changed track");
	assert_eq!(owners::comment(&comment), review, "a review comment changed track");
}

/// A row whose file the snapshot no longer holds has no object to key on, so
/// such rows share the namespace's reserved track. Recorded so the sweep above
/// is not read as a stronger claim than it is.
#[test]
fn rows_with_no_file_behind_them_share_the_reserved_track() {
	assert_eq!(owners::missing(), owners::missing(), "the reserved track is not stable");
	let mut drawn: HashSet<RetainedKey> = Chrome::ALL
		.iter()
		.map(|control| owners::chrome(*control))
		.collect();
	drawn.insert(owners::file(&file_of("src/main.rs")));
	drawn.insert(owners::folder("src"));
	assert!(
		!drawn.contains(&owners::missing()),
		"the reserved track belongs to an object a surface draws"
	);
}

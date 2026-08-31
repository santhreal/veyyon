//! WHY. Every surface derived its own owner keys - a counter, a hash, a number
//! typed into the file that drew the control - and five pairs inside one
//! namespace landed on one key, which draws as a control lighting up while the
//! pointer is on a different one. This is the table they all come from now, so
//! the properties every caller relies on are pinned here rather than in each
//! surface's own suite.
//!
//! THE CLASS. Two names resolving to one key, a name changing key between
//! frames, and a control reaching out of its object's block into the next
//! object's. Names are supplied by the test rather than read from the window,
//! so this says nothing about which names a surface passes; each surface's
//! suite owns that, and
//! `every_control_a_conversation_draws_animates_on_its_own_track`
//! is the pattern.
//!
//! The registry is per thread and holds names for the life of the process, so
//! each test below uses names of its own rather than a fresh table.

use std::collections::HashSet;

use super::{
	model::{OwnerNamespace, RetainedKey},
	owners::{BLOCK, control, owner, owner_at},
};

#[test]
fn two_names_get_two_keys() {
	let first = owner(OwnerNamespace::Shell, "distinct", "one");
	let second = owner(OwnerNamespace::Shell, "distinct", "two");
	assert_ne!(first, second, "two names share one track");
}

#[test]
fn one_name_keeps_its_key() {
	let first = owner(OwnerNamespace::Files, "stable", "row");
	let again = owner(OwnerNamespace::Files, "stable", "row");
	assert_eq!(first, again, "a name moved track between frames");
}

/// Two kinds are two tables, so a row and a control that share a name - a task
/// and an agent both called `build`, a file and a directory both called `src` -
/// do not share a track.
#[test]
fn one_name_under_two_kinds_gets_two_keys() {
	let agent = owner(OwnerNamespace::Agents, "agent", "build");
	let task = owner(OwnerNamespace::Agents, "task", "build");
	assert_ne!(agent, task, "one name under two kinds shares a track");
}

/// A name that carries a number is one object per number, and the number is
/// held apart from the name rather than formatted into it: a search hit at line
/// 12 and the same file at line 120 are two rows the window draws at once.
#[test]
fn one_name_at_two_numbers_gets_two_keys() {
	let file = "src/lib.rs";
	let at_twelve = owner_at(OwnerNamespace::Files, "numbered", file, 12);
	let at_hundred = owner_at(OwnerNamespace::Files, "numbered", file, 120);
	let again = owner_at(OwnerNamespace::Files, "numbered", file, 12);
	assert_ne!(at_twelve, at_hundred, "two numbers under one name share a track");
	assert_eq!(at_twelve, again, "a numbered name moved track between frames");
}

/// The numbered table is not the plain one, so a file's own row and that file
/// at a line are two objects even at number zero.
#[test]
fn a_numbered_name_never_meets_the_name_alone() {
	let file = "src/main.rs";
	let row = owner(OwnerNamespace::Files, "apart", file);
	let at_zero = owner_at(OwnerNamespace::Files, "apart", file, 0);
	assert_ne!(row, at_zero, "a numbered name shares the plain name's track");
}

/// Two numbered names under one number are still two objects, so the number
/// does not become the whole identity.
#[test]
fn two_names_at_one_number_get_two_keys() {
	let first = owner_at(OwnerNamespace::Changes, "line", "a.rs", 7);
	let second = owner_at(OwnerNamespace::Changes, "line", "b.rs", 7);
	assert_ne!(first, second, "two names at one number share a track");
}

/// The namespace is the outer table, so the same name in two namespaces is two
/// objects.
#[test]
fn one_name_in_two_namespaces_gets_two_keys() {
	let shell = owner(OwnerNamespace::Shell, "same", "filter");
	let settings = owner(OwnerNamespace::Settings, "same", "filter");
	assert_ne!(shell, settings, "one name in two namespaces shares a track");
}

/// A key states its namespace in the high byte, which is what keeps two
/// namespaces' tables from meeting however many names either holds.
#[test]
fn a_key_carries_the_namespace_it_was_asked_for() {
	for namespace in [
		OwnerNamespace::Shell,
		OwnerNamespace::Conversation,
		OwnerNamespace::Changes,
		OwnerNamespace::Files,
		OwnerNamespace::Terminal,
		OwnerNamespace::Agents,
		OwnerNamespace::Settings,
		OwnerNamespace::Overlays,
		OwnerNamespace::Render,
		OwnerNamespace::Kit,
	] {
		let key = owner(namespace, "namespaced", "row");
		assert_eq!(key.object >> 56, namespace as u64, "a key left the namespace it was asked for");
		assert_ne!(
			key,
			RetainedKey::reserved(namespace),
			"a name landed on the reserved key, which every fallback shares"
		);
	}
}

/// A control sits inside its own object's block, and two objects' controls
/// never meet.
#[test]
fn a_control_stays_inside_its_object() {
	let mut seen: HashSet<RetainedKey> = HashSet::new();
	for id in ["first", "second", "third"] {
		assert!(
			seen.insert(owner(OwnerNamespace::Changes, "blocked", id)),
			"{id} shares its track with another object"
		);
		for slot in 1..BLOCK {
			let key = control(OwnerNamespace::Changes, "blocked", id, slot as u8);
			assert!(seen.insert(key), "slot {slot} of {id} lands on a track another object owns");
		}
	}
}

/// Slot zero is the object, so a control at slot zero is the object's own
/// track: the surfaces number their controls from one, and this states what the
/// bottom of the block means.
#[test]
fn slot_zero_is_the_object_itself() {
	let object = owner(OwnerNamespace::Terminal, "zero", "row");
	assert_eq!(control(OwnerNamespace::Terminal, "zero", "row", 0), object);
}

/// A slot past the block is held at the top of the block rather than reaching
/// the next object, so a surface that grows past fifteen controls loses one
/// control's separate track instead of animating another object's.
#[test]
fn a_slot_past_the_block_is_held_inside_it() {
	let held = control(OwnerNamespace::Overlays, "clamped", "row", 200);
	let top = control(OwnerNamespace::Overlays, "clamped", "row", (BLOCK - 1) as u8);
	assert_eq!(held, top, "a slot past the block left the object");
	let next = owner(OwnerNamespace::Overlays, "clamped", "after");
	assert_ne!(held, next, "a held slot reached the next object");
}

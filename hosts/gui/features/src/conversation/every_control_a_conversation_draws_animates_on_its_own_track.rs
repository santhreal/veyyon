//! WHY. Every control drawn against a conversation animated on a track derived
//! from a number chosen in the file that drew it: the sidebar row used slots 1
//! and 2, the toolbar used 1 through 6, the sidebar's own fixtures used a hand
//! written band, and the composer another. Both surfaces draw against the
//! selected conversation at once, so Pin and Rename shared one hover track, as
//! did the row's Delete and Branch, and hovering one lit the other.
//!
//! THE CLASS. Two objects a window can draw at the same time resolving to one
//! [`RetainedKey`]. Numbers are gone: every conversation object is named
//! through `kit::motion::owners`, which hands one block of ids per name, and
//! this suite sweeps names rather than the reported pair. It covers the row,
//! every control in [`ControlSlot::ALL`], the sidebar's fixtures, the
//! unreadable rows, and the composer's controls and chips, all out of the one
//! namespace they share. A new control cannot be added quietly:
//! `every_slot_holds_the_offset_it_was_given`
//! and `every_composer_control_is_named` match their enums exhaustively, so a
//! new variant fails to build until it is listed, and the sweeps then cover it.
//!
//! WHAT IT DOES NOT CATCH. Objects in other namespaces, which
//! `kit/src/motion/two_names_never_share_one_track.rs` covers generically, and
//! two names that describe the same object — naming a control twice gives it
//! two tracks, and this suite cannot tell that from two controls. It also says
//! nothing about two controls that share an `ElementId`, which is a different
//! defect with a different symptom.

use std::collections::{BTreeSet, HashSet};

use veyyon_gui_core::model::{AttachmentId, SessionId, SessionStatus, SessionSummary, WorkspaceId};
use veyyon_gui_kit::motion::{BLOCK, OwnerNamespace, RetainedKey};

use super::{
	sessions::{create_owner, load_owner, search_owner},
	state::{ControlSlot, SessionShelfState},
};
use crate::composer::{ChipSlot, Control, attachment_control, attachment_owner, control_owner};

fn id_of(id: &str) -> SessionId {
	SessionId::new(id).expect("the fixture ids are valid")
}

fn attachment_of(id: &str) -> AttachmentId {
	AttachmentId::new(id).expect("the fixture ids are valid")
}

/// The product id inside a key: the namespace occupies the high byte.
fn local_id(key: RetainedKey) -> u64 {
	key.object & 0x00ff_ffff_ffff_ffff
}

fn session(id: &str) -> SessionSummary {
	SessionSummary {
		id:                  id_of(id),
		workspace:           WorkspaceId::new("workspace").expect("the fixture id is valid"),
		path:                format!("/repo/{id}.jsonl"),
		cwd:                 "/repo".to_owned(),
		title:               Some(id.to_owned()),
		parent_path:         None,
		created_at_ms:       1,
		modified_at_ms:      2,
		message_count:       3,
		size_bytes:          4,
		first_message:       None,
		searchable_messages: None,
		status:              SessionStatus::Complete,
	}
}

/// The sidebar's own fixtures, which draw beside the rows.
fn sidebar() -> [RetainedKey; 4] {
	[
		load_owner(),
		create_owner(),
		search_owner(),
		RetainedKey::reserved(OwnerNamespace::Conversation),
	]
}

/// Every control's offset, named one variant at a time. The match is exhaustive
/// and has no wildcard, so a new control fails to build until it is given an
/// offset here and added to [`ControlSlot::ALL`], which every sweep below
/// reads.
#[test]
fn every_slot_holds_the_offset_it_was_given() {
	for slot in ControlSlot::ALL {
		let expected = match slot {
			ControlSlot::Pin => 1,
			ControlSlot::RowDelete => 2,
			ControlSlot::Rename => 3,
			ControlSlot::Branch => 4,
			ControlSlot::Export => 5,
			ControlSlot::Compact => 6,
			ControlSlot::Handoff => 7,
			ControlSlot::Delete => 8,
		};
		assert_eq!(slot.offset(), expected, "{slot:?} moved off its offset");
	}
	let offsets: BTreeSet<u64> = ControlSlot::ALL.iter().map(|slot| slot.offset()).collect();
	assert_eq!(offsets.len(), ControlSlot::ALL.len(), "two controls claim one offset");
}

/// A control's offset stays inside the row's block. Offset zero is the row
/// itself, and the block width is the distance to the next name's block, so an
/// offset at or beyond it animates another object's track.
#[test]
fn no_control_reaches_out_of_its_row() {
	for slot in ControlSlot::ALL {
		assert!(
			slot.offset() > 0 && slot.offset() < BLOCK,
			"{slot:?} sits outside the row's block of {BLOCK}"
		);
	}
}

/// The block itself, swept numerically rather than through the enum, so the
/// claim holds for every offset a control could later be given: a row's block
/// is contiguous from the row's own key and belongs to that row alone.
#[test]
fn a_row_block_holds_every_offset_it_claims() {
	let one = id_of("a");
	let two = id_of("b");
	let first = local_id(SessionShelfState::owner(&one));
	let second = local_id(SessionShelfState::owner(&two));
	assert_ne!(first, second, "two conversations share a block");
	assert!(first.abs_diff(second) >= BLOCK, "two conversations' blocks overlap");
	for offset in 1..BLOCK {
		let slot = u8::try_from(offset).expect("the block is smaller than a byte");
		let key = local_id(control_slot_key(&one, slot));
		assert_eq!(key, first + offset, "offset {offset} left the row's block");
		assert_ne!(key, second, "offset {offset} reached the next conversation's row");
	}
}

/// Reaches the registry with a raw offset, which the enum cannot express, so
/// the test above can sweep the whole block.
fn control_slot_key(session: &SessionId, slot: u8) -> RetainedKey {
	veyyon_gui_kit::motion::control(OwnerNamespace::Conversation, "session", session.as_str(), slot)
}

#[test]
fn a_conversation_gives_each_control_its_own_track() {
	let id = id_of("a");
	let keys: HashSet<RetainedKey> = ControlSlot::ALL
		.iter()
		.map(|slot| SessionShelfState::control_owner(&id, *slot))
		.collect();
	assert_eq!(keys.len(), ControlSlot::ALL.len(), "two controls of one conversation share a track");
	assert!(
		!keys.contains(&SessionShelfState::owner(&id)),
		"a control animates on the row's own track"
	);
}

/// A conversation the session index has not delivered yet is still drawn — a
/// window holds an active session before the index arrives — and its controls
/// are keyed by its id like any other, with no shared fallback.
#[test]
fn a_conversation_outside_the_index_keeps_its_own_tracks() {
	let mut state = SessionShelfState::default();
	state.reconcile(&[session("a")], None);
	let indexed = id_of("a");
	let absent = id_of("not-in-the-index");
	let mut seen: HashSet<RetainedKey> = HashSet::new();
	for id in [&indexed, &absent] {
		assert!(seen.insert(SessionShelfState::owner(id)), "two conversations share a row track");
		for slot in ControlSlot::ALL {
			assert!(
				seen.insert(SessionShelfState::control_owner(id, slot)),
				"{slot:?} of a conversation outside the index shares a track"
			);
		}
	}
}

/// The sidebar's own controls draw beside the row's, so a control key that
/// equals one of them lights the wrong thing.
#[test]
fn no_control_lands_on_a_sidebar_owner() {
	let sidebar = sidebar();
	for id in ["a", "b", "c", "not-in-the-index"] {
		let session = id_of(id);
		for owner in sidebar {
			assert_ne!(
				SessionShelfState::owner(&session),
				owner,
				"the row of {id} animates a sidebar control's track"
			);
			for slot in ControlSlot::ALL {
				assert_ne!(
					SessionShelfState::control_owner(&session, slot),
					owner,
					"{slot:?} of {id} animates a sidebar control's track"
				);
			}
		}
	}
}

/// One conversation's controls never reach into another conversation's block,
/// however many rows arrive.
#[test]
fn no_control_reaches_another_conversation() {
	let ids = ["a", "b", "c", "d", "e"];
	let mut seen: HashSet<RetainedKey> = HashSet::new();
	for id in ids {
		let session = id_of(id);
		assert!(seen.insert(SessionShelfState::owner(&session)), "two conversations share a row");
		for slot in ControlSlot::ALL {
			let key = SessionShelfState::control_owner(&session, slot);
			assert!(seen.insert(key), "{slot:?} of {id} animates a track another control owns");
		}
	}
}

/// A name resolves to the same key every frame, so a control does not jump
/// tracks while the index is arriving or the list is reordered.
#[test]
fn a_name_keeps_its_track_across_frames() {
	let id = id_of("a");
	let row = SessionShelfState::owner(&id);
	let controls: Vec<RetainedKey> = ControlSlot::ALL
		.iter()
		.map(|slot| SessionShelfState::control_owner(&id, *slot))
		.collect();
	// Name several other objects in the same namespace in between, which is what
	// a frame drawing a longer list does.
	for other in ["b", "c", "d"] {
		let _ = SessionShelfState::owner(&id_of(other));
	}
	assert_eq!(SessionShelfState::owner(&id), row, "a row changed track between frames");
	for (slot, expected) in ControlSlot::ALL.iter().zip(controls) {
		assert_eq!(
			SessionShelfState::control_owner(&id, *slot),
			expected,
			"{slot:?} changed track between frames"
		);
	}
}

/// Every composer control is named, one variant at a time. The match is
/// exhaustive and has no wildcard, so a new control fails to build until it is
/// named and listed in [`Control::ALL`], which the sweep below reads.
#[test]
fn every_composer_control_is_named() {
	let names: BTreeSet<&'static str> = Control::ALL.iter().map(|control| control.name()).collect();
	assert_eq!(names.len(), Control::ALL.len(), "two composer controls share one name");
	for control in Control::ALL {
		let expected = match control {
			Control::Files => "files",
			Control::Images => "images",
			Control::Mention => "mention",
			Control::Model => "model",
			Control::Thinking => "thinking",
			Control::QueueSteering => "queue-steering",
			Control::QueueFollowUp => "queue-follow-up",
			Control::QueueInterrupt => "queue-interrupt",
			Control::Background => "background",
			Control::Primary => "primary",
			Control::RetryConnection => "retry-connection",
			Control::RetryFatal => "retry-fatal",
			Control::DenyApproval => "deny-approval",
			Control::ApproveRequest => "approve-request",
			Control::OpenRequestUrl => "open-request-url",
			Control::AnswerRequest => "answer-request",
			Control::ReviewPlan => "review-plan",
		};
		assert_eq!(control.name(), expected, "{control:?} was renamed");
	}
}

/// The composer draws beside the sidebar and the rows out of one namespace, so
/// every object all four surfaces draw at once is swept against every other:
/// rows, row controls, sidebar fixtures, composer controls, and attachment
/// chips with their own controls.
#[test]
fn no_two_objects_a_conversation_draws_share_a_track() {
	let mut seen: HashSet<RetainedKey> = HashSet::new();
	for owner in sidebar() {
		assert!(seen.insert(owner), "two sidebar fixtures share a track");
	}
	for id in ["a", "b", "c"] {
		let session = id_of(id);
		assert!(seen.insert(SessionShelfState::owner(&session)), "the row of {id} shares a track");
		for slot in ControlSlot::ALL {
			assert!(
				seen.insert(SessionShelfState::control_owner(&session, slot)),
				"{slot:?} of {id} shares a track"
			);
		}
	}
	for control in Control::ALL {
		assert!(
			seen.insert(control_owner(control)),
			"the composer's {control:?} shares a conversation control's track"
		);
	}
	for id in ["one", "two", "three"] {
		let attachment = attachment_of(id);
		assert!(seen.insert(attachment_owner(&attachment)), "the chip for {id} shares a track");
		for slot in ChipSlot::ALL {
			assert!(
				seen.insert(attachment_control(&attachment, slot)),
				"{slot:?} of the chip for {id} shares a track"
			);
		}
	}
}

/// A chip's control stays inside the chip's own block, so removing the
/// attachment ahead of it does not move it onto another chip's track.
#[test]
fn no_chip_control_reaches_another_chip() {
	for slot in ChipSlot::ALL {
		assert!(
			slot.offset() > 0 && u64::from(slot.offset()) < BLOCK,
			"{slot:?} sits outside the chip's block of {BLOCK}"
		);
	}
	let first = attachment_of("one");
	let second = attachment_of("two");
	let block = local_id(attachment_owner(&first));
	for slot in ChipSlot::ALL {
		assert_eq!(
			local_id(attachment_control(&first, slot)),
			block + u64::from(slot.offset()),
			"{slot:?} left its chip's block"
		);
		assert_ne!(
			attachment_control(&first, slot),
			attachment_owner(&second),
			"{slot:?} reached the next chip's row"
		);
	}
}

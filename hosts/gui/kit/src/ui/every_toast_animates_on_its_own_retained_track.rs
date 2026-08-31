//! WHY. Two toasts on screen at the same time must never share a RetainedKey,
//! and control slots within a toast's block must never collide or spill into
//! adjacent object blocks.
//!
//! WHAT THIS DOES NOT CATCH. This suite exercises key derivations and slot
//! ranges; full frame render loops are tested in windowed suites.

use std::collections::HashSet;

use super::ToastSlot;
use crate::motion::{BLOCK, OwnerNamespace, control, owner};

#[test]
fn no_two_toasts_share_a_motion_track() {
	let mut keys = HashSet::new();

	for i in 0..100 {
		let id = format!("toast-{i}");
		let key = owner(OwnerNamespace::Overlays, "toast", &id);
		assert!(keys.insert(key), "Duplicate retained key generated for distinct toast id: {id}");
	}
}

#[test]
fn toast_controls_fit_within_motion_block_limit() {
	for slot in ToastSlot::ALL {
		assert!(
			(slot.offset() as u64) < BLOCK,
			"ToastSlot::{:?} offset {} exceeds BLOCK limit {}",
			slot,
			slot.offset(),
			BLOCK
		);
		assert!(slot.offset() > 0, "Slot 0 is reserved for the toast root container");
	}
}

#[test]
fn all_toast_slots_are_distinct_and_named() {
	let mut seen_offsets = HashSet::new();
	let mut seen_names = HashSet::new();

	for slot in ToastSlot::ALL {
		assert!(seen_offsets.insert(slot.offset()), "Duplicate offset for ToastSlot::{:?}", slot);
		assert!(seen_names.insert(slot.name()), "Duplicate name for ToastSlot::{:?}", slot);
	}
}

#[test]
fn toast_control_keys_are_distinct_from_root_and_each_other() {
	let toast_id = "toast-example";
	let root_key = owner(OwnerNamespace::Overlays, "toast", toast_id);
	let dismiss_key =
		control(OwnerNamespace::Overlays, "toast", toast_id, ToastSlot::Dismiss.offset());
	let action_key =
		control(OwnerNamespace::Overlays, "toast", toast_id, ToastSlot::Action.offset());

	assert_ne!(root_key, dismiss_key);
	assert_ne!(root_key, action_key);
	assert_ne!(dismiss_key, action_key);
}

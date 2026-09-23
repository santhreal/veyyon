//! WHY: `CapabilityMap` held a fixed array written as the literal `32`, and
//! `get` and `set` bounds-check the discriminant against that array. The
//! thirty-third capability, `Profiles`, was declared with discriminant 32, so
//! every report of it was dropped on the floor and every read of it answered
//! `UnknownUntilAttached`. Nothing failed: a gate that asks whether a
//! capability is unavailable saw an unknown, took it for not-declined, and
//! drew a surface for a host that had refused it.
//!
//! CLASS CLOSED: a capability the protocol declares whose status the map
//! cannot carry. The sweep is over `Capability::ALL` at run time, not a list
//! written here, and each capability is required to store and read back each
//! of the three statuses independently of the others. A capability added to
//! the enum arrives in this sweep with no edit, and a map that cannot hold it
//! fails here rather than in whatever surface was gated on it.
//!
//! GAPS: which surface is gated on which capability, which
//! `crates/veyyon-desktop/tests/
//! a-palette-mode-is-opened-by-a-row-that-states-what-carries-it.rs`
//! and the per-surface suites own, and whether the host reports the capability
//! at all, which is the gui-host's contract.

use veyyon_desktop_model::{Capability, CapabilityMap, CapabilityStatus};

/// The three statuses a host can leave a capability in.
fn statuses() -> Vec<CapabilityStatus> {
	vec![
		CapabilityStatus::UnknownUntilAttached,
		CapabilityStatus::Available,
		CapabilityStatus::Unavailable { reason: "not on this host".to_owned() },
	]
}

#[test]
fn every_declared_capability_stores_and_reads_back_each_status() {
	for capability in Capability::ALL {
		for status in statuses() {
			let mut map = CapabilityMap::new();
			map.set(capability, status.clone());
			assert_eq!(
				map.get(capability),
				&status,
				"{} read back as something other than what was reported for it",
				capability.as_str()
			);
		}
	}
}

#[test]
fn a_status_reported_for_one_capability_reaches_no_other() {
	for capability in Capability::ALL {
		let mut map = CapabilityMap::new();
		map.set(capability, CapabilityStatus::Available);
		let leaked: Vec<&'static str> = Capability::ALL
			.into_iter()
			.filter(|other| *other != capability)
			.filter(|other| map.get(*other) != &CapabilityStatus::UnknownUntilAttached)
			.map(Capability::as_str)
			.collect();
		assert_eq!(
			leaked,
			Vec::<&'static str>::new(),
			"reporting {} moved the status of another capability",
			capability.as_str()
		);
	}
}

#[test]
fn the_map_holds_one_row_per_declared_capability() {
	// The array length is what `get` and `set` bounds-check against, so a map
	// shorter than the enum silently drops the capabilities past its end.
	assert_eq!(
		CapabilityMap::new().statuses.len(),
		Capability::ALL.len(),
		"the map must carry a row for every capability the protocol declares"
	);
}

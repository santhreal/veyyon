//! WHY: `/queue-mode` and `/queue` were listed on the command surface by a
//! host that had stated it carries no background submission. Running one
//! returned at the availability check and drew nothing, so the operator read a
//! command that does nothing as a command that is broken. §5.13 authors the
//! opposite: a surface absent for want of a capability is not rendered, never
//! rendered disabled.
//!
//! THE CLASS THIS CLOSES: a command listed on the palette whose action the
//! host declines. The sweep is over `ComposerCommand::iter()` at run time and
//! each variant's own `capability()`, so a new command that names a capability
//! is pruned by construction and a new command that names none turns the
//! pinned opt-out list red until someone records the decision. The drawer's
//! `/terminal` is the two-tenant case and is pinned by
//! `a-drawer-the-host-does-not-offer-is-not-drawn-empty`; here it only has to
//! keep standing while another capability is withdrawn.
//!
//! WHAT IT DOES NOT CATCH: whether a listed command's action reaches the host,
//! which `an-intent-maps-to-the-actions-the-host-answers` drives, and the
//! composer's own arrow gate, which is `project_controls`' and is asserted by
//! `a-control-is-offered-only-while-the-transport-can-carry-it`.

#[path = "support/mod.rs"]
mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator;
use support::NOW_MS;
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{Capability, CapabilityStatus, ConnectionState, QueuePartition, Store};
use veyyon_desktop_surface::{
	Overlay, PaletteItemKind, PaletteMode, PaletteState, ShellState,
	palette::commands::ComposerCommand,
};

/// An attached host carrying everything, so one withdrawn capability is the
/// only reason a command can be missing.
fn attached() -> Store {
	let mut store = Store {
		connection: ConnectionState::Connected { endpoint: "socket".to_string(), protocol: 1 },
		..Store::default()
	};
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let session = support::session("s1", QueuePartition::Live);
	let id = session.id.clone();
	store.sessions.insert(session);
	store.persisted.shell.active_session = Some(id);
	store
}

/// The commands the palette lists after a projection, by name.
fn listed(store: &Store) -> Vec<String> {
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::commands())),
		..ShellState::default()
	};
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	let Some(Overlay::Palette(palette)) = &state.overlay else {
		panic!("the palette stays open across a projection");
	};
	assert_eq!(
		palette.mode,
		PaletteMode::Commands,
		"the filter changes what is listed, not what the palette is listing"
	);
	palette
		.items
		.iter()
		.filter_map(|item| match &item.kind {
			PaletteItemKind::Composer { command } => Some(command.name().to_owned()),
			_ => None,
		})
		.collect()
}

#[test]
fn a_command_whose_capability_the_host_declines_leaves_the_list() {
	let every = listed(&attached());
	for command in ComposerCommand::iter() {
		let Some(capability) = command.capability() else {
			continue;
		};
		let mut store = attached();
		store
			.capabilities
			.set(capability, CapabilityStatus::Unavailable {
				reason: format!("{} is not available on this host", capability.as_str()),
			});
		let remaining = listed(&store);

		assert!(
			!remaining.contains(&command.name().to_owned()),
			"{} needs {}, which the host declined, so it is not listed: {remaining:?}",
			command.name(),
			capability.as_str()
		);
		for other in ComposerCommand::iter() {
			if other.capability() == Some(capability) {
				continue;
			}
			assert!(
				remaining.contains(&other.name().to_owned()),
				"withdrawing {} took {} with it: {remaining:?}",
				capability.as_str(),
				other.name()
			);
		}
		assert!(
			every.contains(&command.name().to_owned()),
			"{} is listed by a host that carries {}: {every:?}",
			command.name(),
			capability.as_str()
		);
	}
}

#[test]
fn a_host_that_has_not_answered_yet_holds_nothing_back() {
	// §4.3 separates "declined" from "not stated": a window before its first
	// capability frame lists every command rather than pruning the surface
	// down to the two the operator can always reach.
	let mut store = attached();
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::UnknownUntilAttached);
	}
	let unknown = listed(&store);
	for command in ComposerCommand::iter() {
		assert!(
			unknown.contains(&command.name().to_owned()),
			"{} is missing from an unattached window: {unknown:?}",
			command.name()
		);
	}
}

#[test]
fn every_command_states_which_capability_carries_it() {
	// A new command declaring no capability is a command no host can decline.
	// That is a decision, so it is pinned here by exact equality rather than
	// by a count: the draft's own attachment picker and a steer, which rides
	// on the turn control the composer's arrow already gates.
	let ungated: Vec<&str> = ComposerCommand::iter()
		.filter(|command| command.capability().is_none())
		.map(ComposerCommand::name)
		.collect();
	assert_eq!(
		ungated,
		vec!["/attach", "/steer"],
		"a command with no capability of its own is a decision to record"
	);
}

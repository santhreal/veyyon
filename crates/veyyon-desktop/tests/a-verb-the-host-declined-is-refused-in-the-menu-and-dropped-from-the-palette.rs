//! WHY: the palette pruned a row whose capability the host declined, and the
//! menu bar arrived with an enablement rule of its own. Two rules for one
//! fact drift: a verb stays pressable in a menu after its row left the
//! palette, and the press returns at an availability check with nothing
//! drawn. §5.13 states a surface the host does not offer is not offered, and
//! the bar and the palette are two presentations of that one fact.
//!
//! CLASS CLOSED: a verb's availability on both surfaces, swept over
//! `Capability::ALL` at run time and over the verbs the menus actually hold,
//! read from `MenuSectionId::iter()`. Withdrawing one capability is required
//! to refuse exactly the menu entries that ride on it and to drop exactly the
//! palette rows that carry them, with every other entry and row left
//! standing. A new capability joins the sweep the moment the enum grows, a
//! new menu verb the moment a section holds it, and a verb that names no
//! capability is pinned by exact equality so excusing one is a recorded
//! decision.
//!
//! WHAT IT DOES NOT CATCH: what a verb does once it is offered, which is that
//! verb's own suite, and how a refused entry is drawn, which
//! `the-menu-bar-takes-the-verb-the-keyboard-walked-to` drives through the
//! real view. The drawer's two tenants are asserted here as parity, while the
//! surface it opens stays
//! `a-drawer-the-host-does-not-offer-is-not-drawn-empty`'s.

#[path = "support/mod.rs"]
mod support;

use std::collections::{BTreeSet, HashMap};

use strum::IntoEnumIterator;
use support::NOW_MS;
use veyyon_desktop::{SessionIndex, command_declined, project};
use veyyon_desktop_model::{Capability, CapabilityStatus, ConnectionState, QueuePartition, Store};
use veyyon_desktop_surface::{
	Command, MenuSectionId, Overlay, PaletteItemKind, PaletteState, ShellState, palette::PaletteMeta,
};

/// An attached host carrying everything, so one withdrawn capability is the
/// only reason a verb can be refused.
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

fn withdraw(store: &mut Store, capability: Capability) {
	store
		.capabilities
		.set(capability, CapabilityStatus::Unavailable {
			reason: format!("{} is not available on this host", capability.as_str()),
		});
}

/// Every verb a menu holds, in bar order.
fn menu_verbs() -> Vec<Command> {
	MenuSectionId::iter()
		.flat_map(|section| section.entries().iter().copied())
		.collect()
}

/// What one projection of `store` leaves on each surface: the verbs the bar
/// refuses, and the verbs whose palette row survived.
fn projected(store: &Store) -> (BTreeSet<&'static str>, BTreeSet<&'static str>) {
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::commands())),
		..ShellState::default()
	};
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	let refused: BTreeSet<&'static str> = state
		.menu
		.declined
		.iter()
		.map(|command| command.name())
		.collect();
	let Some(Overlay::Palette(palette)) = &state.overlay else {
		panic!("the palette stays open across a projection");
	};
	let listed: BTreeSet<&'static str> = palette
		.items()
		.iter()
		.filter_map(|item| match (&item.kind, &item.meta) {
			// A composer row answers on its own command, which the palette's
			// own suite covers; the parity here is the row that carries one of
			// the bar's verbs.
			(PaletteItemKind::Composer { .. }, _) => None,
			(_, Some(PaletteMeta::Chord(command))) => Some(command.name()),
			_ => None,
		})
		.collect();
	(refused, listed)
}

#[test]
fn withdrawing_a_capability_refuses_exactly_the_verbs_that_ride_on_it() {
	for capability in Capability::ALL {
		let mut store = attached();
		withdraw(&mut store, capability);
		let (refused, _) = projected(&store);
		let expected: BTreeSet<&'static str> = menu_verbs()
			.into_iter()
			.filter(|command| command_declined(&store, *command))
			.map(Command::name)
			.collect();
		assert_eq!(
			refused,
			expected,
			"a host without {} refuses the verbs that ride on it and no others",
			capability.as_str()
		);
		for command in menu_verbs() {
			let rides_on_it = command.capability() == Some(capability)
				|| (command == Command::ToggleDrawer
					&& matches!(capability, Capability::Terminals | Capability::ProcessSupervisor));
			if !rides_on_it {
				assert!(
					!refused.contains(command.name()),
					"withdrawing {} took {} with it",
					capability.as_str(),
					command.name()
				);
			}
		}
	}
}

#[test]
fn a_verb_the_menu_refuses_has_no_palette_row_left() {
	let (offered_at_full, listed_at_full) = projected(&attached());
	assert!(
		offered_at_full.is_empty(),
		"a host carrying everything refuses nothing: {offered_at_full:?}"
	);
	assert!(
		!listed_at_full.is_empty(),
		"the palette lists rows that carry a verb, or this suite compares two empty sets"
	);

	for capability in Capability::ALL {
		let mut store = attached();
		withdraw(&mut store, capability);
		let (refused, listed) = projected(&store);
		for name in &refused {
			assert!(
				!listed.contains(name),
				"the bar refuses {name} without {}, and the palette still lists it",
				capability.as_str()
			);
		}
		for name in &listed_at_full {
			let row_dropped = !listed.contains(name);
			assert_eq!(
				row_dropped,
				refused.contains(name),
				"{name}: the palette dropped its row ({row_dropped}) and the bar refused its entry \
				 ({}) disagree without {}",
				refused.contains(name),
				capability.as_str()
			);
		}
	}
}

#[test]
fn the_drawer_stands_while_either_tenant_carries_it() {
	// The one verb two capabilities offer. Withdrawing one leaves it, and the
	// palette's row has to follow the same answer rather than the capability
	// literal a row states for itself.
	for one in [Capability::Terminals, Capability::ProcessSupervisor] {
		let mut store = attached();
		withdraw(&mut store, one);
		let (refused, listed) = projected(&store);
		assert!(
			!refused.contains(Command::ToggleDrawer.name()),
			"the drawer has another tenant without {}, so its entry stands",
			one.as_str()
		);
		assert!(
			listed.contains(Command::ToggleDrawer.name()),
			"the drawer's row stands while its entry does"
		);
	}

	let mut store = attached();
	withdraw(&mut store, Capability::Terminals);
	withdraw(&mut store, Capability::ProcessSupervisor);
	let (refused, listed) = projected(&store);
	assert!(
		refused.contains(Command::ToggleDrawer.name()),
		"a host that runs no terminal and supervises no process refuses the drawer"
	);
	assert!(
		!listed.contains(Command::ToggleDrawer.name()),
		"the drawer's row leaves the palette with its entry"
	);
}

#[test]
fn a_host_that_has_not_answered_yet_refuses_nothing() {
	// §4.3 separates "declined" from "not stated": a window before its first
	// capability frame draws every entry offered rather than a bar of refusals.
	let mut store = attached();
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::UnknownUntilAttached);
	}
	let (refused, _) = projected(&store);
	assert_eq!(
		refused,
		BTreeSet::from([Command::ToggleDrawer.name()]),
		"an unattached window refuses only the drawer, whose surface would arrive empty"
	);
}

#[test]
fn the_menu_verbs_no_host_can_decline_are_exactly_these() {
	// A verb with no capability is a verb the window answers by itself. That
	// is a decision, so it is pinned by name: a new verb that names none turns
	// this red until someone records why no host can decline it.
	let ungated: Vec<&'static str> = menu_verbs()
		.into_iter()
		.filter(|command| command.capability().is_none())
		.map(Command::name)
		.collect();
	assert_eq!(
		ungated,
		vec![
			"OpenPalette",
			"OpenSettings",
			"CloseWindow",
			"Quit",
			"TogglePinSelected",
			"ToggleDeferSelected",
			"ToggleParkSelected",
			"FilterQueue",
			"CloseTabOrPark",
			"ToggleQueue",
			"TogglePanel",
			"ToggleDrawer",
			"PreviousTab",
			"NextTab",
			"ToggleDiffMode",
			"FindInTranscript",
			"PreviousTurn",
			"NextTurn",
			"ToggleBlock",
			"CopySelection",
			"SelectEntryText",
			"AttachFile",
		],
		"a menu verb no host can decline is a decision to record"
	);
}

//! WHY THIS SUITE EXISTS:
//! A control never decides its own availability: `project_controls` reads the
//! capability the host declared for the action behind that control and writes
//! the answer into `ControlStates`, and the control draws what it is told.
//! Between the table that pairs a control with its action and the projection
//! that reads it, a pair can be declared and never consulted. The composer's
//! microphone was in that state: `ComposerDictateButton` was paired with
//! `ToggleDictation`, `ToggleDictation` resolved to `Capability::Dictation`,
//! and the button drew identically whether the host offered dictation or
//! refused it, because nothing on the path asserted that a refused capability
//! reaches the control it gates.
//!
//! THE CLASS THIS CLOSES:
//! Every capability, crossed with every control the projection gates, both
//! read from the source at run time: `Capability::ALL` for the refusals and
//! `gated_controls` for the controls, so a capability added to the enum or a
//! control added to the table is swept here without an edit. Both directions
//! are asserted on every pass --- the controls that capability gates are
//! withheld, and every other gated control in the same window stays offered
//! --- so a control wired to the wrong capability fails as surely as one that
//! ignores its own. The reason is compared by equality, so a control that
//! substitutes a sentence of its own for the host's fails rather than passing
//! as merely unavailable.
//! A control dropped from the table instead of mis-gated is caught one step
//! earlier: `composer_controls` returns a fixed-size array, so removing a pair
//! changes its length and fails to compile.
//!
//! WHAT IT DOES NOT CATCH:
//! The transport dimension, which narrows a gate after the capability decides
//! it and is
//! `a-control-is-offered-only-while-the-transport-can-carry-it.rs`. Nor
//! whether the host states the capability from the settings in effect, which
//! is the host's own and is asserted in
//! `a-capability-a-setting-withholds-follows-that-setting.test.ts`. The sweep
//! reads the controls this fixture's store reaches: one live session with no
//! decision pending, so a control projected only from a provider, an MCP
//! server, a keybinding, a terminal or an open question is outside it.

use std::collections::HashMap;

use veyyon_desktop::{SessionIndex, gated_controls, project, project_controls, scene::seed::Seed};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, HostActionKind, PROTOCOL_VERSION, QueuePartition,
	SurfaceId, action_to_capability,
};
use veyyon_desktop_surface::{Availability, ShellState};

/// The clock the projection measures elapsed labels against, pinned so the
/// suite does not read the wall.
const CLOCK_MS: u64 = 1_700_000_000_000;

/// The sentence the host gives for the one capability each pass refuses,
/// distinct enough that a control stating anything else is stating its own.
const REFUSAL: &str = "the host does not implement it";

/// The window one refused capability projects, with the control table that
/// window was gated from. The transport is connected and every other
/// capability is available, so what withholds a control here is the
/// capability and nothing else.
fn projected(refused: Capability) -> (ShellState, Vec<(SurfaceId, HostActionKind)>) {
	let mut seed = Seed::connection(ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	});
	for capability in Capability::ALL {
		seed
			.store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	seed
		.store
		.capabilities
		.set(refused, CapabilityStatus::Unavailable { reason: REFUSAL.to_string() });
	let session = seed.session(QueuePartition::Live);
	let mut index = SessionIndex::new();
	let mut shell = ShellState::default();
	project(&seed.store, &mut index, &HashMap::new(), CLOCK_MS, &mut shell);
	project_controls(&seed.store, &seed.registry, &index, &mut shell);
	let row = index
		.row_id(&session)
		.expect("the session listed holds a row id");
	let controls = gated_controls(&seed.store, &index, Some(row));
	(shell, controls)
}

/// Whether the projection withholds this control for a capability other than
/// the one its own action resolves to.
///
/// The queue toggle is the one control that is: a refused background
/// submission takes the mode away, and the sentence it states names the
/// submission the toggle would queue rather than the capability behind it.
fn withheld_beside_its_own_capability(surface: &SurfaceId, refused: Capability) -> bool {
	matches!(surface, SurfaceId::ComposerQueueModeToggle(_))
		&& refused == Capability::BackgroundSubmission
}

#[test]
fn a_refused_capability_reaches_every_control_it_gates() {
	for refused in Capability::ALL {
		let (shell, controls) = projected(refused);
		for (surface, action) in controls {
			let availability = shell.controls.availability(&surface);
			if action_to_capability(action) == refused
				|| withheld_beside_its_own_capability(&surface, refused)
			{
				match availability {
					Availability::Unavailable { reason } => assert!(
						!reason.is_empty(),
						"{surface:?} withheld by {refused:?} states why it is withheld"
					),
					other => panic!("{surface:?} is offered as {other:?} while {refused:?} is refused"),
				}
			} else {
				assert_eq!(
					availability,
					Availability::Enabled,
					"{surface:?} is gated by {action:?} and only {refused:?} is refused"
				);
			}
		}
	}
}

#[test]
fn the_reason_a_withheld_control_states_is_the_one_the_host_gave() {
	for refused in Capability::ALL {
		let (shell, controls) = projected(refused);
		for (surface, action) in controls {
			if action_to_capability(action) != refused {
				continue;
			}
			assert_eq!(
				shell.controls.availability(&surface),
				Availability::Unavailable { reason: REFUSAL.to_string() },
				"{surface:?} states the reason the host gave for {refused:?}"
			);
		}
	}
}

#[test]
fn which_capabilities_gate_no_control_in_this_window_is_recorded() {
	// The two tests above sweep the controls a capability gates, so a
	// capability that gates none of them passes both by covering nothing.
	// The set is pinned by equality rather than counted: a capability that
	// stops being reachable from a control, or a new one that arrives with no
	// control behind it, fails here until the decision is recorded.
	//
	// Each one below is reached from a control this fixture's store does not
	// hold, which is the fixture's bound and not a gap in the projection:
	// a provider or account row (`Authentication`), an installed extension
	// (`Extensions`, `Mcp`), a bound key (`Keybindings`), a settings field
	// (`Settings`), a roster row (`Agents`), an edit awaiting review
	// (`PendingEdits`), a decision the session is waiting on (`Plans`,
	// `Questions`), a row of an open swarm console (`Autoswarm`), and the
	// queue toggle, which this window gates through `SetQueueMode` and
	// withholds for `BackgroundSubmission` separately.
	let mut unreached: Vec<String> = Vec::new();
	for refused in Capability::ALL {
		let (_, controls) = projected(refused);
		if !controls
			.iter()
			.any(|(_, action)| action_to_capability(*action) == refused)
		{
			unreached.push(format!("{refused:?}"));
		}
	}
	unreached.sort();
	assert_eq!(unreached, [
		"Agents",
		"Authentication",
		"Autoswarm",
		"BackgroundSubmission",
		"Extensions",
		"Keybindings",
		"Mcp",
		"PendingEdits",
		"Plans",
		"Questions",
		"Settings",
	]);
}

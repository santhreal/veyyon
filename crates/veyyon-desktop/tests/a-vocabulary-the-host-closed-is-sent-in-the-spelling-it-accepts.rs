//! WHY THIS SUITE EXISTS
//!
//! The Changes tab's scope toggle did nothing in every shipped session. The
//! window sent `SelectChangeScope { scope: "working_tree" }`, hand-written in
//! `actions_for`, and the host accepts `"WorkingTree"` or `"Staged"` and
//! answers anything else with `INVALID_ARGUMENTS`. Nothing in the window reads
//! that refusal: the scope it draws comes from the `ChangesView` the host
//! sends, so a refused switch leaves the same list on screen and the toggle
//! reads as inert. `SetQueueMode` had the same shape and had already been
//! repaired by hand, with a comment above it stating the host's spelling --
//! which is the evidence that a hand-written vocabulary is the defect, not one
//! wrong string.
//!
//! THE CLASS THIS CLOSES: a closed vocabulary crossing the wire as a literal
//! written beside the action instead of as the type the window decodes the
//! same vocabulary with. Every scope and every mode is swept from the enum
//! itself, so a variant added to either turns this red until it round-trips,
//! and every string field of every action a sample intent produces is
//! censused, so a new action carrying a hand-written vocabulary appears as an
//! unclassified path rather than passing unseen.
//!
//! WHAT IT DOES NOT CATCH: a field the host reads under another name, a
//! vocabulary the window legitimately carries as an open string because the
//! host itself supplied the value (a thinking level, a model id), and anything
//! about whether the host acts on the value once it decodes.

mod support;

use std::collections::BTreeSet;

use serde_json::Value;
use strum::IntoEnumIterator;
use support::{intent_samples::every_sample_intent, session};
use veyyon_desktop::{SessionIndex, actions_for};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ChangeScope, HostAction, QueueMode, QueuePartition, SessionId,
	SettableMode, Store, SupervisorSignal,
};
use veyyon_desktop_surface::Intent;

/// Every string an action carries that is an operator's or the host's own
/// value rather than a vocabulary: text, identifiers, paths and queries. A new
/// entry here is a decision that the value is open.
const OPEN_STRINGS: [&str; 58] = [
	"AbortTurn.session",
	"BranchSession.session",
	"CancelAuthFlow.provider",
	"CancelTask.task_id",
	"CancelTool.session",
	"CancelTool.tool_call_id",
	"ClearOutput.session",
	"CompactSession.session",
	"DeleteSession.session",
	"DequeueQueuedPrompt.session",
	"ExportSession.format",
	"ExportSession.session",
	"FollowUp.session",
	"FollowUp.text",
	"GetContextBreakdown.session",
	"GetUsage.session",
	"HandoffSession.session",
	"HandoffSession.target",
	"LoadTranscript.session",
	"OpenAuthUrl.url",
	"OpenExternal.path",
	"OpenSession.session",
	"ProcessLogs.process_id",
	"ProcessRestart.process_id",
	"ProcessSend.process_id",
	"ProcessSignal.process_id",
	"ProcessStart.args[]",
	"ProcessStart.command",
	"ProcessStop.process_id",
	"ReadFile.path",
	"RenameSession.session",
	"RenameSession.title",
	"ResetSetting.key",
	"RetryAuthFlow.provider",
	"RetryDiagnosticSource.source",
	"ReviveAgent.agent_id",
	"SearchContent.query",
	"SearchFiles.query",
	"SelectModel.model",
	"SelectModel.provider",
	"SetKeybinding.action",
	"SetKeybinding.keys[]",
	"SetMcpEnabled.server",
	"SetQueueMode.session",
	"SetSessionMode.session",
	"SetSetting.key",
	"SetSetting.value",
	"SetThinkingLevel.level",
	"SetToolViewExpanded.call_id",
	"SetToolViewExpanded.session",
	"SpawnTask.task",
	"StartProviderAuth.provider",
	"Steer.session",
	"Steer.text",
	"SubmitAuthSecret.provider",
	"SubmitAuthSecret.secret",
	"SubmitPrompt.session",
	"SubmitPrompt.text",
];

/// Every string that is one of a closed set the host rejects anything outside
/// of, and that the window carries as the type it decodes the same set with.
/// A member here is round-tripped through that type below; a member added
/// without one leaves the sweep proving nothing about it.
const VOCABULARY_STRINGS: [&str; 4] =
	["ProcessSignal.signal", "SelectChangeScope.scope", "SetQueueMode.mode", "SetSessionMode.mode"];

fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let mut index = SessionIndex::new();
	let _ = index.row_of(&id);
	(store, index)
}

/// The payload of the one action of `variant` the intent produced.
fn payload_of(actions: &[HostAction], variant: &str) -> Value {
	let payloads: Vec<Value> = actions
		.iter()
		.filter_map(|action| {
			let value = serde_json::to_value(action).expect("an action serializes");
			value.get(variant).cloned()
		})
		.collect();
	assert_eq!(payloads.len(), 1, "expected one {variant} among {actions:?}");
	payloads.into_iter().next().expect("one payload")
}

/// Every `<Variant>.<field>` path under which a string reaches the host,
/// descending into nested objects and arrays so an attachment's own fields are
/// censused beside the action's.
fn census(value: &Value, path: &str, found: &mut BTreeSet<String>) {
	match value {
		Value::String(_) => {
			found.insert(path.to_owned());
		},
		Value::Array(items) => {
			for item in items {
				census(item, &format!("{path}[]"), found);
			}
		},
		Value::Object(fields) => {
			for (name, field) in fields {
				let next = if path.is_empty() {
					name.clone()
				} else {
					format!("{path}.{name}")
				};
				census(field, &next, found);
			}
		},
		_ => {},
	}
}

#[test]
fn every_scope_and_every_mode_reaches_the_host_as_the_vocabulary_it_came_from() {
	let mut proven: BTreeSet<String> = BTreeSet::new();

	for scope in ChangeScope::iter() {
		let (mut store, index) = seeded();
		let actions = actions_for(&Intent::SelectChangeScope(scope), &index, &mut store);
		let sent = payload_of(&actions, "SelectChangeScope")["scope"].clone();
		let decoded: ChangeScope = serde_json::from_value(sent.clone())
			.unwrap_or_else(|_| panic!("the host's ChangeScope cannot read {sent}"));
		assert_eq!(decoded, scope, "the scope sent for {scope:?} decodes as {decoded:?}");
		// The bytes the host accepts, from `handleSelectChangeScope` in
		// `packages/coding-agent/src/gui-host/actions/changes.ts`. Decoding
		// alone only proves the window agrees with itself: renaming the enum's
		// serialization keeps that true and stops the host reading it.
		let expected = match scope {
			ChangeScope::WorkingTree => "WorkingTree",
			ChangeScope::Staged => "Staged",
		};
		assert_eq!(sent, Value::String(expected.to_owned()));
		proven.insert("SelectChangeScope.scope".to_owned());
	}

	for mode in QueueMode::iter() {
		let (mut store, index) = seeded();
		let actions = actions_for(&Intent::SetQueueMode(mode), &index, &mut store);
		let sent = payload_of(&actions, "SetQueueMode")["mode"].clone();
		let decoded: QueueMode = serde_json::from_value(sent.clone())
			.unwrap_or_else(|_| panic!("the host's QueueMode cannot read {sent}"));
		assert_eq!(decoded, mode, "the mode sent for {mode:?} decodes as {decoded:?}");
		// `QUEUE_MODES` in `packages/coding-agent/src/gui-host/actions/turn.ts`.
		let expected = match mode {
			QueueMode::Steer => "Steer",
			QueueMode::Queue => "Queue",
		};
		assert_eq!(sent, Value::String(expected.to_owned()));
		proven.insert("SetQueueMode.mode".to_owned());
	}

	for mode in SettableMode::iter() {
		let (mut store, index) = seeded();
		let on = mode == SettableMode::Plan;
		let actions = actions_for(&Intent::SetPlanMode { on }, &index, &mut store);
		let sent = payload_of(&actions, "SetSessionMode")["mode"].clone();
		let decoded: SettableMode = serde_json::from_value(sent.clone())
			.unwrap_or_else(|_| panic!("the host's SettableMode cannot read {sent}"));
		assert_eq!(decoded, mode, "the mode sent for {mode:?} decodes as {decoded:?}");
		// `SESSION_MODES` in `packages/coding-agent/src/gui-host/actions/turn.ts`.
		let expected = match mode {
			SettableMode::Plan => "plan",
			SettableMode::None => "none",
		};
		assert_eq!(sent, Value::String(expected.to_owned()));
		proven.insert("SetSessionMode.mode".to_owned());
	}

	for signal in SupervisorSignal::iter() {
		let (mut store, index) = seeded();
		let intent = Intent::ProcessSignal { process: "server".to_owned(), signal };
		let actions = actions_for(&intent, &index, &mut store);
		let sent = payload_of(&actions, "ProcessSignal")["signal"].clone();
		let decoded: SupervisorSignal = serde_json::from_value(sent.clone())
			.unwrap_or_else(|_| panic!("the host's SupervisorSignal cannot read {sent}"));
		assert_eq!(decoded, signal, "the signal sent for {signal:?} decodes as {decoded:?}");
		// `DAEMON_SIGNALS` in `packages/coding-agent/src/launch/protocol.ts`,
		// which the supervisor validates every signal against before it
		// reaches the process.
		let expected = match signal {
			SupervisorSignal::Interrupt => "SIGINT",
			SupervisorSignal::Terminate => "SIGTERM",
			SupervisorSignal::HangUp => "SIGHUP",
			SupervisorSignal::Quit => "SIGQUIT",
			SupervisorSignal::Kill => "SIGKILL",
		};
		assert_eq!(sent, Value::String(expected.to_owned()));
		proven.insert("ProcessSignal.signal".to_owned());
	}

	// A vocabulary recorded and never round-tripped here is a claim with no
	// evidence behind it, so the census and this sweep name the same set.
	let recorded: BTreeSet<String> = VOCABULARY_STRINGS
		.iter()
		.map(|path| (*path).to_owned())
		.collect();
	assert_eq!(proven, recorded, "every recorded vocabulary is round-tripped here");
}

#[test]
fn a_scope_switch_asks_for_the_changes_of_the_scope_it_switched_to() {
	// The refresh that follows the switch is what redraws the list, and the
	// order is the contract: a refresh sent first answers with the scope the
	// operator just left.
	for scope in ChangeScope::iter() {
		let (mut store, index) = seeded();
		let actions = actions_for(&Intent::SelectChangeScope(scope), &index, &mut store);
		assert_eq!(
			actions,
			vec![HostAction::SelectChangeScope { scope }, HostAction::RefreshChanges],
			"switching to {scope:?}"
		);
	}
}

#[test]
fn every_string_an_action_carries_is_classified() {
	let mut found = BTreeSet::new();
	for intent in every_sample_intent() {
		let (mut store, index) = seeded();
		for action in actions_for(&intent, &index, &mut store) {
			let value = serde_json::to_value(&action).expect("an action serializes");
			// A unit variant serializes to its own name, which is the action
			// rather than a field of one.
			if value.is_string() {
				continue;
			}
			census(&value, "", &mut found);
		}
	}
	let expected: BTreeSet<String> = OPEN_STRINGS
		.iter()
		.chain(VOCABULARY_STRINGS.iter())
		.map(|path| (*path).to_owned())
		.collect();
	let unrecorded: Vec<&String> = found.difference(&expected).collect();
	let stale: Vec<&String> = expected.difference(&found).collect();
	assert!(
		unrecorded.is_empty() && stale.is_empty(),
		"a string field is unaccounted for: type it as the vocabulary the host closes, or record it \
		 as an open value.\nsent but not recorded: {unrecorded:#?}\nrecorded but never sent: \
		 {stale:#?}"
	);
}

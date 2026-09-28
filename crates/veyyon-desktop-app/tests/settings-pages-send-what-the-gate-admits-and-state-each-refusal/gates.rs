//! Every control asks one gate, `AppState::gate`, whether the host takes its
//! action, and states the reason that gate gives when it does not.
//!
//! WHY: a control wired to the wrong capability offers a request the host
//! refuses or withholds one it would take; a gate that reads an undeclared
//! capability as a refusal withholds every control before the host answers;
//! a gate that reads a request in flight as one withholds the page while it
//! waits, and one that reads it over a refusal offers what the host refuses.
//! The sweeps read `Capability::iter()`, `HostActionKind::iter()` and
//! `Page::ALL` at run time, so a new capability, action or page is swept with
//! no edit here, and the capabilities no action maps to are pinned by exact
//! equality, so a new one is red until it is decided.
//!
//! Gap: the drawn partition is asserted on the settings pages only; the
//! panel, drawer, sidebar and composer draw their own refused controls and
//! their suites assert them. The link narrows the gate after the capability
//! and is `link.rs`.

use gpui::{AppContext as _, Entity, TestAppContext};
use serde_json::json;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{AppState, settings::Page};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, Gate, HostAction, HostActionKind, HostEvent, SnapshotSection,
	Store, action_to_capability,
};

use super::harness::{accounts_and_servers, settings, window};

/// The host's declaration of `capabilities`, each at `status`.
fn declared(capabilities: &[Capability], status: &CapabilityStatus) -> HostEvent {
	let statuses = capabilities
		.iter()
		.map(|capability| (*capability, status.clone()))
		.collect();
	HostEvent::Snapshot(SnapshotSection::Capabilities(statuses))
}

fn closed(reason: &str) -> CapabilityStatus {
	CapabilityStatus::Unavailable { reason: reason.to_owned() }
}

/// What the gate answers, and the reason it states, for every action.
fn gates(
	state: &Entity<AppState>,
	app: &TestAppContext,
) -> Vec<(HostActionKind, Gate, Option<String>)> {
	state.read_with(app, |state, _| {
		HostActionKind::iter()
			.map(|kind| (kind, state.gate(kind), state.refusal(kind)))
			.collect()
	})
}

#[gpui::test]
fn every_capability_withholds_exactly_the_actions_it_gates_in_the_hosts_words(
	app: &mut TestAppContext,
) {
	let state = app.new(|_| AppState::new(Store::new()));
	for (kind, gate, refusal) in gates(&state, app) {
		assert_eq!(
			(gate, refusal),
			(Gate::Unknown, None),
			"{kind:?} is offered before the host declares it"
		);
	}
	let every: Vec<Capability> = Capability::iter().collect();
	let apply = |app: &mut TestAppContext, event: HostEvent| {
		state.update(app, |state, cx| state.apply(vec![event], cx));
	};
	apply(app, declared(&every, &CapabilityStatus::Available));

	let mut gating_nothing = Vec::new();
	for capability in Capability::iter() {
		let reason = format!("{capability:?} is off on this host");
		apply(app, declared(&[capability], &closed(&reason)));
		let mut withheld = 0;
		for (kind, gate, refusal) in gates(&state, app) {
			if action_to_capability(kind) == capability {
				withheld += 1;
				assert_eq!(
					gate,
					Gate::Unavailable { reason: reason.clone() },
					"{capability:?} withholds {kind:?}"
				);
				assert_eq!(
					refusal.as_deref(),
					Some(reason.as_str()),
					"{kind:?} states the host's reason"
				);
			} else {
				assert_eq!(
					(gate, refusal),
					(Gate::Enabled, None),
					"{capability:?} leaves {kind:?} offered"
				);
			}
		}
		if withheld == 0 {
			gating_nothing.push(capability);
		}
		apply(app, declared(&[capability], &CapabilityStatus::Available));
	}
	assert_eq!(
		gating_nothing,
		vec![
			Capability::BackgroundSubmission,
			Capability::Questions,
			Capability::Plans,
			Capability::PendingEdits,
			Capability::Todo,
		],
		"the capabilities no action maps to: a surface reads them whole, not through a request"
	);
}

#[gpui::test]
fn a_request_in_flight_withholds_nothing_and_states_no_reason(app: &mut TestAppContext) {
	let mut w = window(app, vec![settings()]);
	w.open("general#context");
	w.sent();
	w.click("settings.control:toggle-retry.enabled");
	let flip = w.one();
	let (gate, refusal) = w.state.read_with(&*w.cx, |state, _| {
		(state.gate(HostActionKind::SetSetting), state.refusal(HostActionKind::SetSetting))
	});
	assert_eq!((gate, refusal), (Gate::Pending { request: flip.id }, None));
	w.submit("compaction.threshold", "42");
	let key = "compaction.threshold".to_owned();
	assert_eq!(
		w.sent(),
		vec![HostAction::SetSetting { key, value: json!(42) }],
		"a control whose kind of request is in flight is still offered"
	);
	assert_eq!(w.error(), None, "and no reason is stated for it");
}

/// The host refusing a capability while a request of it waits withholds every
/// action of that capability at once, the one in flight and its siblings:
/// the waiting request meets the same refusal.
#[gpui::test]
fn a_refusal_stated_while_a_request_waits_withholds_its_controls(app: &mut TestAppContext) {
	let mut w = window(app, vec![settings()]);
	w.open("general#context");
	w.sent();
	w.click("settings.control:toggle-retry.enabled");
	w.one();
	let capability = action_to_capability(HostActionKind::SetSetting);
	let reason = "Settings are locked on this host";
	w.apply(vec![declared(&[capability], &closed(reason))]);
	let gated: Vec<(HostActionKind, Gate)> = w.state.read_with(&*w.cx, |state, _| {
		HostActionKind::iter()
			.filter(|kind| action_to_capability(*kind) == capability)
			.map(|kind| (kind, state.gate(kind)))
			.collect()
	});
	let refused = Gate::Unavailable { reason: reason.to_owned() };
	let expected: Vec<(HostActionKind, Gate)> = gated
		.iter()
		.map(|(kind, _)| (*kind, refused.clone()))
		.collect();
	assert!(gated.len() > 1, "the sweep holds the waiting action's siblings: {gated:?}");
	assert_eq!(gated, expected);
	w.submit("compaction.threshold", "42");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "the refused control sends nothing");
	assert_eq!(w.error().as_deref(), Some(reason), "and states the host's reason");
}

#[gpui::test]
fn each_page_loads_whether_or_not_declared_and_a_refused_load_states_the_hosts_reason(
	app: &mut TestAppContext,
) {
	let mut events = vec![settings()];
	events.extend(accounts_and_servers());
	let mut w = window(app, events);
	for page in Page::ALL {
		let gated: Vec<Capability> = page
			.loads()
			.iter()
			.map(|action| action_to_capability(action.kind()))
			.collect();
		w.reopen(page.name());
		assert_eq!(w.sent(), page.loads(), "{page:?} loads before the host declares {gated:?}");
		assert_eq!(w.error(), None);
		let at_rest = w.texts();
		w.apply(vec![declared(&gated, &CapabilityStatus::Available)]);
		w.reopen(page.name());
		assert_eq!(w.sent(), page.loads(), "{page:?} loads once the host declares {gated:?}");
		assert_eq!(w.texts(), at_rest, "{page:?} draws a declared capability as an undeclared one");

		let reason = format!("{page:?} is off on this host");
		w.apply(vec![declared(&gated, &closed(&reason))]);
		for other in Page::ALL.into_iter().filter(|other| *other != page) {
			w.reopen(other.name());
			assert_eq!(w.sent(), other.loads(), "refusing {gated:?} leaves {other:?} loading");
			assert_eq!(w.error(), None, "and states nothing on {other:?}");
		}
		w.reopen(page.name());
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "{page:?} asks for nothing the host refused");
		assert_eq!(w.error().as_deref(), Some(reason.as_str()), "{page:?} states the host's reason");

		w.apply(vec![declared(&gated, &CapabilityStatus::UnknownUntilAttached)]);
		assert_eq!(w.sent(), page.loads(), "{page:?} asks again once the gate takes its load");
		assert_eq!(w.error(), None, "and states the refusal no longer");
	}
}

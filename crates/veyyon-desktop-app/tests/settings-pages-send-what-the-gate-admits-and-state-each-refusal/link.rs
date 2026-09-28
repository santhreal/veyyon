//! The link to the host narrows the gate after the capability decides it: a
//! link being retried, or one that failed, carries only the requests that
//! restore or leave it, and a page whose load it held back loads once the
//! link returns.
//!
//! WHY: the capability map keeps what the host declared while it was
//! reachable, so a window reading it alone offers every control over a link
//! that is being retried or has failed, and a request sent there waits for a
//! socket that may never come. The sweep crosses `ConnectionStateKind::iter()`
//! with `HostActionKind::iter()` over `AppState::gate` and the reason a panel
//! or drawer control draws (`panel_unavailable`); the match from a kind
//! to its sample states is exhaustive, so a seventh state does not compile
//! until its rule is written, and the carried set is pinned by exact equality.
//!
//! Gap: that a detached window, or one on its first attempt, queues what it
//! sends until the link starts is the transport's contract, which this suite
//! does not drive; it asserts only that the window offers those requests.

use gpui::{AppContext as _, TestAppContext};
use serde_json::json;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::AppState;
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, ConnectionStateKind, Gate, HostAction,
	HostActionKind, HostEvent, LINK_FAILED, LINK_RETRYING, SnapshotSection, Store,
};

use super::harness::{settings, window};

/// The states of `kind` the sweep drives, each with the reason the window
/// gives for withholding a request there, or `None` where it offers them.
fn samples(kind: ConnectionStateKind) -> Vec<(ConnectionState, Option<&'static str>)> {
	match kind {
		ConnectionStateKind::Detached => vec![(ConnectionState::Detached, None)],
		ConnectionStateKind::Connecting => vec![
			(ConnectionState::Connecting { attempt: 1 }, None),
			(ConnectionState::Connecting { attempt: 2 }, Some(LINK_RETRYING)),
		],
		ConnectionStateKind::Syncing => {
			vec![(ConnectionState::Syncing { received: 1, expected: Some(3) }, None)]
		},
		ConnectionStateKind::Connected => vec![(connected(), None)],
		ConnectionStateKind::Reconnecting => vec![(retrying(), Some(LINK_RETRYING))],
		ConnectionStateKind::Fatal => vec![(failed(), Some(LINK_FAILED))],
	}
}

fn connected() -> ConnectionState {
	ConnectionState::Connected { endpoint: "gui-host".to_owned(), protocol: 1 }
}

fn retrying() -> ConnectionState {
	ConnectionState::Reconnecting {
		attempt:     1,
		retry_at_ms: 500,
		message:     "the socket closed".to_owned(),
	}
}

fn failed() -> ConnectionState {
	ConnectionState::Fatal { message: "the host speaks another protocol".to_owned() }
}

#[gpui::test]
fn a_lost_or_failed_link_carries_only_the_requests_that_restore_or_leave_it(
	app: &mut TestAppContext,
) {
	let state = app.new(|_| AppState::new(Store::new()));
	let apply = |app: &mut TestAppContext, event: HostEvent| {
		state.update(app, |state, cx| state.apply(vec![event], cx));
	};
	let every = Capability::iter()
		.map(|capability| (capability, CapabilityStatus::Available))
		.collect();
	apply(app, HostEvent::Snapshot(SnapshotSection::Capabilities(every)));

	for kind in ConnectionStateKind::iter() {
		for (connection, withheld) in samples(kind) {
			apply(app, HostEvent::ConnectionChanged(connection.clone()));
			let mut carried = Vec::new();
			for action in HostActionKind::iter() {
				let (gate, drawn) = state
					.read_with(app, |state, _| (state.gate(action), state.panel_unavailable(action)));
				let reason = match &gate {
					Gate::Unavailable { reason } => Some(reason.clone()),
					_ => None,
				};
				assert_eq!(drawn, reason, "a panel or drawer control draws the gate's reason");
				match withheld {
					None => assert_eq!(gate, Gate::Enabled, "{connection:?} offers {action:?}"),
					Some(_) if gate == Gate::Enabled => carried.push(action),
					Some(reason) => assert_eq!(
						gate,
						Gate::Unavailable { reason: reason.to_owned() },
						"{connection:?} withholds {action:?} for the link's reason"
					),
				}
			}
			if withheld.is_some() {
				assert_eq!(
					carried,
					vec![
						HostActionKind::Attach,
						HostActionKind::Detach,
						HostActionKind::RetryConnection
					],
					"{connection:?} carries only what restores or leaves the link"
				);
			}
		}
	}

	let host = "The host holds its lifecycle";
	let lifecycle =
		vec![(Capability::Lifecycle, CapabilityStatus::Unavailable { reason: host.to_owned() })];
	apply(app, HostEvent::Snapshot(SnapshotSection::Capabilities(lifecycle)));
	for connection in [retrying(), failed(), connected()] {
		apply(app, HostEvent::ConnectionChanged(connection.clone()));
		let gate = state.read_with(app, |state, _| state.gate(HostActionKind::RetryConnection));
		assert_eq!(
			gate,
			Gate::Unavailable { reason: host.to_owned() },
			"{connection:?} never offers what the host refused"
		);
	}
}

#[gpui::test]
fn a_page_opened_over_a_lost_link_sends_nothing_and_loads_once_the_link_returns(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![settings()]);
	w.apply(vec![HostEvent::ConnectionChanged(retrying())]);
	w.open("general#context");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a page asks for nothing over a lost link");
	assert_eq!(w.error().as_deref(), Some(LINK_RETRYING));
	w.click("settings.control:toggle-retry.enabled");
	w.submit("compaction.threshold", "42");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "nor does any control on it");

	w.apply(vec![HostEvent::ConnectionChanged(failed())]);
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	assert_eq!(
		w.error().as_deref(),
		Some(LINK_FAILED),
		"the page states why the link withholds it now"
	);

	w.apply(vec![HostEvent::ConnectionChanged(connected())]);
	assert_eq!(
		w.sent(),
		vec![HostAction::LoadSettings],
		"the page asks again once the link returns"
	);
	assert_eq!(w.error(), None);
	w.click("settings.control:toggle-retry.enabled");
	let key = "retry.enabled".to_owned();
	assert_eq!(w.sent(), vec![HostAction::SetSetting { key, value: json!(true) }]);
}

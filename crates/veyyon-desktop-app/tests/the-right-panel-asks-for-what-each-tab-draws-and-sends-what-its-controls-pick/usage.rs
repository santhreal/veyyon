//! The usage tab the thread header opens draws the displayed session's
//! accounting and context window as the host counted them, asks for each half
//! by the capability that answers it, and stays shown across the snapshots
//! that follow.
//!
//! WHY: the retired window received a session's accounting with nowhere to
//! draw it, then closed the tab opened for it on the next snapshot. The
//! rebuilt tab sent both of its requests under the `Usage` capability alone:
//! a host declining `ContextBreakdown` was asked, on every visit, for a count
//! it could only refuse, and one declining `Usage` was never asked for the
//! context window it answers, which then read "not measured yet" for good.
//! The class is a figure withheld, or asked for, by a capability that is not
//! its own, a half drawn waiting for an answer the host declined to give, and
//! an opened tab lost to an unrelated snapshot. `half` is exhaustive over the
//! requests `loads` states for the tab, so a third figure fails here until
//! its capability and its waiting sentence are stated.
//!
//! Gap: this suite dispatches the `ShowPanelTab` the turn footer and the
//! thread header's control send; the transcript suite's `footer` clicks the
//! footer, and the header's control is clicked by no test.
//! The quota rows are not driven, and the refresh control's disabled state is
//! read only through what its click sends.

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ContextBreakdownView, ContextCategory, HostAction, HostActionKind,
	HostEvent, SessionId, SnapshotSection, UsageTotals, UsageView,
};

use super::{
	changes,
	harness::{SESSION, answer, opened, window},
	loads,
};

/// The tab's refresh control, which asks for both halves.
const REFRESH: &str = "usage-refresh";

/// The capability answering the usage tab's request `action`, and the
/// sentence its half draws until the host answers it.
fn half(action: &HostAction) -> (Capability, &'static str) {
	match action.kind() {
		HostActionKind::GetUsage => (Capability::Usage, "The host has not counted this session yet"),
		HostActionKind::GetContextBreakdown => {
			(Capability::ContextBreakdown, "The host has not measured the context yet")
		},
		other => panic!("the usage tab asks for {other:?}; state the half it fills"),
	}
}

fn spent(session: &str, input_tokens: u64) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Usage(UsageView {
		session: SessionId::from(session),
		totals:  UsageTotals {
			input_tokens,
			output_tokens: 340,
			cache_read_tokens: 9_000,
			cache_write_tokens: 120,
			orchestration_tokens: 40,
			premium_requests: 3,
			cost_microusd: Some(21_000),
		},
	}))
}

fn context() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ContextBreakdown(ContextBreakdownView {
		session:      SessionId::from(SESSION),
		total_tokens: 50_000,
		limit_tokens: Some(200_000),
		categories:   vec![ContextCategory { name: "messages".to_owned(), tokens: 48_000 }],
	}))
}

/// The host answering every capability but `declined`, which it refuses
/// for `reason`.
fn declining(declined: Capability, reason: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Capabilities(
		Capability::ALL
			.into_iter()
			.map(|each| {
				let status = if each == declined {
					CapabilityStatus::Unavailable { reason: reason.to_owned() }
				} else {
					CapabilityStatus::Available
				};
				(each, status)
			})
			.collect(),
	))
}

#[gpui::test]
fn the_opened_usage_tab_draws_the_sessions_accounting_and_holds_across_snapshots(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Usage);
	let asked = w.requests();
	let sent: Vec<_> = asked.iter().map(|request| request.action.clone()).collect();
	assert_eq!(sent, loads(PanelTab::Usage), "opening the tab asks for what it draws");
	for action in &sent {
		let (_, waiting) = half(action);
		assert!(w.draws(waiting), "{waiting:?} until the host answers");
	}

	w.apply(vec![spent("other", 777_777), spent(SESSION, 1_200), context()]);
	answer(&mut w, asked);
	for figure in ["1,200", "340", "9,000", "120", "$0.0210", "50,000 of 200,000 (25%)", "48,000"] {
		assert!(w.draws(figure), "the tab draws {figure:?}: {:?}", w.texts());
	}
	assert!(!w.draws("777,777"), "and not another session's accounting");

	w.apply(vec![
		changes(),
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Changes,
			CapabilityStatus::Available,
		)])),
		spent(SESSION, 1_500),
	]);
	assert_eq!(w.active(), PanelTab::Usage, "a snapshot that follows leaves the tab shown");
	assert!(w.draws("1,500"), "and the tab draws the count the host sent last");
}

#[gpui::test]
fn each_half_of_the_usage_tab_is_asked_by_its_own_capability_and_states_its_refusal(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Usage);
	let first = w.requests();
	answer(&mut w, first);
	let halves = loads(PanelTab::Usage);
	for declined in &halves {
		let (capability, waiting) = half(declined);
		let reason = format!("{} is off on this host", capability.as_str());
		w.apply(vec![declining(capability, &reason)]);
		let asked = w.requests();
		let sent: Vec<_> = asked.iter().map(|request| request.action.clone()).collect();
		let others: Vec<_> = halves
			.iter()
			.filter(|each| *each != declined)
			.cloned()
			.collect();
		assert_eq!(sent, others, "a host declining {capability:?} is asked for the other half");
		answer(&mut w, asked);
		assert!(w.draws(&reason), "the declined half states why: {:?}", w.texts());
		assert!(!w.draws(waiting), "rather than waiting for an answer that cannot come");
		for other in &others {
			let (_, waiting) = half(other);
			assert!(w.draws(waiting), "the half the host takes still waits for its answer");
		}
		w.click(REFRESH);
		let asked = w.requests();
		let sent: Vec<_> = asked.iter().map(|request| request.action.clone()).collect();
		assert_eq!(
			sent, others,
			"the refresh control asks a host declining {capability:?} for the rest"
		);
		answer(&mut w, asked);

		w.apply(vec![HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			capability,
			CapabilityStatus::Available,
		)]))]);
		let asked = w.requests();
		let sent: Vec<_> = asked.iter().map(|request| request.action.clone()).collect();
		assert_eq!(sent, halves, "a host that takes it again is asked for both halves");
		answer(&mut w, asked);
	}
}

#[gpui::test]
fn a_host_declining_both_halves_leaves_the_refresh_control_asking_nothing(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Usage);
	let first = w.requests();
	answer(&mut w, first);
	let halves = loads(PanelTab::Usage);
	let declined: Vec<_> = halves
		.iter()
		.map(|action| {
			let (capability, _) = half(action);
			let reason = format!("{} is off on this host", capability.as_str());
			(capability, CapabilityStatus::Unavailable { reason })
		})
		.collect();
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Capabilities(declined.clone()))]);
	let asked = w.requests();
	assert!(asked.is_empty(), "a host declining both halves is asked for neither: {asked:?}");
	for (capability, _) in &declined {
		let reason = format!("{} is off on this host", capability.as_str());
		assert!(w.draws(&reason), "each half states its own refusal: {:?}", w.texts());
	}
	w.click(REFRESH);
	assert!(w.requests().is_empty(), "the refresh control is refused while both halves are");
}

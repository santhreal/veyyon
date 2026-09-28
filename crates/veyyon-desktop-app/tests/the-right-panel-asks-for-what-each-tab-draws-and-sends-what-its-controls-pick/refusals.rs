//! A request a panel tab sent and the host refused is stated on that tab in
//! the host's own sentence, with a Retry exactly when the host said it takes
//! a second send, and a dismissal that forgets it.
//!
//! WHY: the panel ended the spinner of a refused request and drew nothing
//! else, so a tab whose load the host refused read "Changes have not loaded"
//! under its Load button, the sentence that says why was never drawn, and a
//! refusal the host called final was still offered again. The sweep is over
//! `PanelTab::ALL` and every request each tab's load queued, read back from
//! the outbox rather than listed here, so a tab added with a load of its own
//! is refused and asserted with no edit to this file; the tabs that ask
//! nothing are pinned by exact equality.
//!
//! Gap: the controls inside a tab are covered by the scope switch and the
//! opened file, not swept. That every panel control is stated by some tab is
//! the exhaustive match of `PanelTab::stating`, which fails to compile on a
//! new `SurfaceId` rather than failing here. Where the row sits in the tab is
//! not asserted.

use gpui::TestAppContext;
use veyyon_desktop_app::{actions::panel::OpenFile, panel::PanelTab};
use veyyon_desktop_model::{ChangeScope, HostAction, HostRequest, SessionId, SurfaceId};

use super::{
	changes,
	harness::{SESSION, Win, opened, refused, window},
};

/// How many Retry controls the last frame drew.
fn retries(w: &mut Win<'_>) -> usize {
	w.texts()
		.iter()
		.filter(|text| text.trim() == "Retry")
		.count()
}

/// The one request queued since the last drain that `pick` accepts.
fn one(w: &mut Win<'_>, pick: impl Fn(&HostAction) -> bool) -> HostRequest {
	let mut picked: Vec<HostRequest> = w
		.requests()
		.into_iter()
		.filter(|request| pick(&request.action))
		.collect();
	assert_eq!(picked.len(), 1, "one such request is queued: {picked:?}");
	picked.remove(0)
}

/// The sentence the host refuses `request` of `tab` with on pass `pass`.
fn sentence(tab: PanelTab, request: &HostRequest, pass: &str) -> String {
	format!("{} refused {:?} on the {pass} send", tab.name(), request.action.kind())
}

#[gpui::test]
fn every_tab_states_the_refusal_of_what_it_asked_for_and_offers_retry_only_when_taken(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(SESSION));
	let mut standing: Vec<String> = Vec::new();
	let mut silent = Vec::new();
	for tab in PanelTab::ALL {
		w.open(tab);
		for other in &standing {
			assert!(!w.draws(other), "{tab:?} states {other:?}, which another tab was refused");
		}
		let asked = w.requests();
		if asked.is_empty() {
			silent.push(tab);
			continue;
		}

		let first: Vec<String> = asked
			.iter()
			.map(|request| sentence(tab, request, "first"))
			.collect();
		w.apply(
			asked
				.iter()
				.zip(&first)
				.map(|(request, copy)| refused(request.id, copy, true))
				.collect(),
		);
		for copy in &first {
			assert!(w.draws(copy), "{tab:?} states {copy:?} in {:?}", w.texts());
		}
		assert_eq!(retries(&mut w), asked.len(), "{tab:?} offers one Retry per refusal taken again");

		for _ in &asked {
			w.click_text("Retry");
		}
		let again = w.requests();
		let resent: Vec<&HostAction> = again.iter().map(|request| &request.action).collect();
		let refused_actions: Vec<&HostAction> = asked.iter().map(|request| &request.action).collect();
		assert_eq!(resent.len(), asked.len(), "Retry sends each refused request once: {resent:?}");
		for action in refused_actions {
			assert!(resent.contains(&action), "{tab:?} Retry sends {action:?} again: {resent:?}");
		}
		for copy in &first {
			assert!(!w.draws(copy), "{tab:?} still states {copy:?} after it was sent again");
		}

		let last: Vec<String> = again
			.iter()
			.map(|request| sentence(tab, request, "second"))
			.collect();
		w.apply(
			again
				.iter()
				.zip(&last)
				.map(|(request, copy)| refused(request.id, copy, false))
				.collect(),
		);
		for copy in &last {
			assert!(w.draws(copy), "{tab:?} states the final {copy:?} in {:?}", w.texts());
		}
		assert_eq!(retries(&mut w), 0, "{tab:?} offers no Retry for a refusal the host called final");
		standing.extend(last);
	}
	assert_eq!(silent, vec![PanelTab::Todo], "only the todo tab asks the host for nothing");
}

#[gpui::test]
fn a_refused_control_inside_a_tab_is_stated_on_that_tab_alone(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Diff);
	w.requests();
	w.apply(vec![changes()]);
	w.click_text("Staged");
	let scope = one(&mut w, |action| matches!(action, HostAction::SelectChangeScope { .. }));
	assert_eq!(scope.action, HostAction::SelectChangeScope { scope: ChangeScope::Staged });
	w.apply(vec![refused(scope.id, "the index is locked", true)]);
	assert!(w.draws("the index is locked"), "the diff tab states it: {:?}", w.texts());
	assert_eq!(retries(&mut w), 1);

	w.click("panel.tab:files");
	w.requests();
	assert!(!w.draws("the index is locked"), "the files tab does not state the diff's refusal");
	w.cx
		.dispatch_action(OpenFile { path: "src/lib.rs".to_owned(), line: None });
	w.cx.run_until_parked();
	let read = one(&mut w, |action| matches!(action, HostAction::ReadFile { .. }));
	w.apply(vec![refused(read.id, "src/lib.rs is not readable", false)]);
	assert!(w.draws("src/lib.rs is not readable"), "the files tab states it: {:?}", w.texts());
	assert!(!w.draws("Loading"), "a refused file is not drawn as on its way");
	assert_eq!(retries(&mut w), 0, "and offers no Retry the host called final");

	w.click("panel.tab:diff");
	w.requests();
	assert!(w.draws("the index is locked"), "the diff's refusal is stated when its tab is");
	assert!(!w.draws("src/lib.rs is not readable"), "and the file's is not");
}

#[gpui::test]
fn a_refusal_of_a_control_outside_the_panel_is_stated_on_no_tab(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	let session = SessionId::from(SESSION);
	let outside = [
		(
			HostAction::AbortTurn { session: session.clone() },
			SurfaceId::ComposerAbortButton(session.clone()),
		),
		(HostAction::RefreshChanges, SurfaceId::GlobalTitlebarLine),
		(HostAction::ReadFile { path: "src/lib.rs".to_owned() }, SurfaceId::PaletteInput),
		(
			HostAction::ClearTerminal { terminal_id: "t1".to_owned() },
			SurfaceId::TerminalClearButton(session.clone(), "t1".to_owned()),
		),
	];
	let mut copies = Vec::new();
	for (ix, (action, surface)) in outside.into_iter().enumerate() {
		let request = w
			.state
			.update(w.cx, |state, cx| state.dispatch(action, surface, cx));
		let copy = format!("refused outside the panel, {ix}");
		w.apply(vec![refused(request, &copy, true)]);
		copies.push(copy);
	}
	for tab in PanelTab::ALL {
		w.open(tab);
		w.requests();
		for copy in &copies {
			assert!(!w.draws(copy), "{tab:?} states {copy:?}, which it never sent");
		}
		assert_eq!(retries(&mut w), 0, "{tab:?} offers a Retry for a request it never sent");
	}
}

#[gpui::test]
fn a_dismissed_refusal_leaves_the_tab_and_its_own_load_returns(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Diff);
	let load = one(&mut w, |action| *action == HostAction::RefreshChanges);
	w.apply(vec![refused(load.id, "no repository here", false)]);
	assert!(w.draws("no repository here"), "{:?}", w.texts());
	assert!(!w.draws("Load changes"), "a refused load is not offered beside its refusal");

	w.click("panel.dismiss:0");
	assert!(!w.draws("no repository here"), "a dismissed refusal is gone from the next frame");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "dismissing sends nothing");
	assert!(w.draws("Load changes"), "the tab's own load is offered again");
}

//! A branch forks at a prompt and hands that prompt to the fork's draft.
//!
//! WHY: the host forks only at a prompt and returns the words it cut off to
//! no window. A `BranchSession` sent naming no entry leaves the fork point to
//! the host and loses the prompt; a prompt written into the draft before the
//! fork is shown lands in the session the window left; a refused branch that
//! still hands its prompt over prepends words to a draft that never forked.
//!
//! Gap: the hover row's pointer path is not driven; the request is sent
//! through `AppState::dispatch`, which every branch control calls.

use gpui::TestAppContext;
use veyyon_desktop_model::{
	EntryId, HostAction, HostEvent, MessageRole, RequestId, SessionHeaderView, SessionId,
	SnapshotSection, SurfaceId, TranscriptEntry, Versioned,
};

use super::{Win, entry, refused, sid, window};

fn linked(id: &str, parent: Option<&str>, role: MessageRole, text: &str) -> TranscriptEntry {
	TranscriptEntry { parent: parent.map(EntryId::from), ..entry(id, role, text, 2) }
}

/// Session `s` with two prompts, each answered.
fn conversation() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 2,
		value:    vec![
			linked("s-0", None, MessageRole::User, "Index the repo."),
			linked("s-1", Some("s-0"), MessageRole::Assistant, "Indexed 40 files."),
			linked("s-2", Some("s-1"), MessageRole::User, "Name the build target."),
			linked("s-3", Some("s-2"), MessageRole::Assistant, "The target is `app`."),
		],
	}))
}

/// The host making fork `f` of session `s` active and answering `request`.
fn forked(request: RequestId) -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             SessionId::from("f"),
		schema_version: 1,
		title:          None,
		title_source:   None,
		parent:         Some(sid()),
		created_at_ms:  0,
		cwd:            "/w/s".to_owned(),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 3,
			value:    header,
		})),
		HostEvent::RequestSucceeded { request },
	]
}

fn branch(w: &mut Win<'_>, entry: Option<&str>) -> RequestId {
	let action = HostAction::BranchSession { session: sid(), entry: entry.map(EntryId::from) };
	w.state
		.update(w.cx, |state, cx| state.dispatch(action, SurfaceId::SessionBranchButton(sid()), cx))
}

#[gpui::test]
fn a_branch_that_names_no_entry_forks_at_the_last_prompt_and_drafts_it(app: &mut TestAppContext) {
	let mut w = window(app, vec![conversation()]);
	let request = branch(&mut w, None);
	assert_eq!(
		w.sent(),
		vec![HostAction::BranchSession { session: sid(), entry: Some(EntryId::from("s-2")) }],
		"the request names the last prompt, not the reply after it"
	);
	assert_eq!(w.draft(), "", "nothing is drafted before the host forks");
	w.apply(forked(request));
	assert_eq!(w.draft(), "Name the build target.", "the fork's draft holds the prompt it cut off");
}

#[gpui::test]
fn a_branch_at_an_earlier_prompt_drafts_that_prompt(app: &mut TestAppContext) {
	let mut w = window(app, vec![conversation()]);
	let request = branch(&mut w, Some("s-0"));
	assert_eq!(w.sent(), vec![HostAction::BranchSession {
		session: sid(),
		entry:   Some(EntryId::from("s-0")),
	}]);
	w.apply(forked(request));
	assert_eq!(w.draft(), "Index the repo.");
}

#[gpui::test]
fn a_refused_branch_hands_nothing_to_the_draft(app: &mut TestAppContext) {
	let mut w = window(app, vec![conversation()]);
	w.write("Keep this.");
	let request = branch(&mut w, None);
	w.drain();
	w.apply(vec![refused(request)]);
	assert_eq!(w.draft(), "Keep this.", "a refused branch leaves the draft as typed");
	w.apply(vec![HostEvent::RequestSucceeded { request }]);
	assert_eq!(w.draft(), "Keep this.", "a late answer to a settled branch hands nothing over");
}

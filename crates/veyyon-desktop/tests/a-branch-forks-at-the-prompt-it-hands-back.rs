//! WHY: the row menu's `Branch` sent `BranchSession { entry: None }` and did
//! nothing else, so the host picked the fork point on its own and the prompt
//! that fork cut off the transcript was reported to nobody. Every other host
//! hands that prompt back for editing (`agent.branch` returns it as
//! `selectedText`, which the terminal writes into its editor and the RPC mode
//! returns as `branch.data.text`); the desktop dropped it, and the branched
//! session carries a genuine prefix of the source that stops before the
//! prompt, so the words were reachable from no surface at all.
//!
//! CLASS CLOSED: a branch whose named entry and returned prompt come from two
//! different walks of the transcript, and a settled request of any other kind
//! writing over the composer. Both readings come from one function here, the
//! row menu's answers are swept from `card_row_answers` at run time, and the
//! draft is pinned to the one answer that may hand text back, by exact
//! equality: an answer added to that table, or a second surface taught to
//! restore a draft, turns this suite red.
//!
//! NOT CAUGHT: that the host forks where it was told to -- that is
//! `a-branch-forks-at-the-entry-the-desktop-named.test.ts`, which drives the
//! real handler; the pixels of the composer the text lands in, which the
//! surface crate's composer suites own; and that `host_view::attach` calls
//! `branched_draft` at all, which sits inside the spawned event loop of a live
//! window, as `restored_draft` does, and is proved by the branch scene's
//! Before/After pair rather than in process.

mod support;

use support::{entry, session};
use veyyon_desktop::{
	SessionIndex, actions_for,
	project::{branch_point, branched_draft},
};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostAction, MessageRole, QueuePartition, SessionId, Store, SurfaceId,
	TranscriptEntry,
};
use veyyon_desktop_surface::{Intent, queue::card_row_answers};

/// The prompt the operator sent last, which is the one a branch cuts.
const LAST_PROMPT: &str = "read the file first, then change it";
/// A prompt before it, on the same branch, which a branch leaves alone.
const EARLIER_PROMPT: &str = "what does this crate do";

/// The key a row's own controls register under: the row, not the session, which
/// is what `session_row_controls` and `surface_for_action` both write (§4.3).
fn row_surface(row: u64) -> SessionId {
	SessionId::from(row.to_string())
}

/// A session the window holds a transcript for: two prompts, each answered,
/// so the last operator entry is not the branch's leaf.
fn seeded(store: &mut Store, id: &str) -> SessionId {
	let session_id = SessionId::from(id);
	store.sessions.insert(session(id, QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());
	let tree = store.transcripts.entry(session_id.clone()).or_default();
	for appended in [
		entry("e1", None, MessageRole::User, vec![ContentBlock::Text {
			text: EARLIER_PROMPT.to_string(),
		}]),
		entry("e2", Some("e1"), MessageRole::Assistant, vec![ContentBlock::Text {
			text: "it draws the desktop".to_string(),
		}]),
		entry("e3", Some("e2"), MessageRole::User, vec![ContentBlock::Text {
			text: LAST_PROMPT.to_string(),
		}]),
		entry("e4", Some("e3"), MessageRole::Assistant, vec![ContentBlock::Text {
			text: "reading it now".to_string(),
		}]),
	] {
		tree.append(appended);
	}
	session_id
}

#[test]
fn a_branch_names_the_last_prompt_on_the_branch_it_forks() {
	let mut store = Store::new();
	let session_id = seeded(&mut store, "sess-1");
	let mut index = SessionIndex::new();
	let row = index.row_of(&session_id);

	assert_eq!(
		actions_for(&Intent::BranchSession(row), &index, &mut store),
		vec![HostAction::BranchSession {
			session: session_id.clone(),
			entry:   Some(EntryId::from("e3")),
		}],
		"the branch names the operator's last prompt, not the reply that followed it"
	);
	assert_eq!(
		branched_draft(&store, &index, &SurfaceId::SessionBranchButton(row_surface(row))).as_deref(),
		Some(LAST_PROMPT),
		"the prompt handed back is the one the named entry holds"
	);
}

/// One walk, so the entry the host is given and the text the composer receives
/// cannot disagree. A transcript whose branch was abandoned proves it: the
/// active leaf decides which prompt is last, and a reading that walked the
/// entry map instead would answer with the other one.
#[test]
fn the_entry_named_and_the_prompt_returned_come_from_one_walk() {
	let mut store = Store::new();
	let session_id = seeded(&mut store, "sess-1");
	let tree = store
		.transcripts
		.get_mut(&session_id)
		.expect("the seeded transcript");
	// A second child of `e2`: the branch the operator is on now, whose own
	// prompt is the last one. The abandoned `e3` stays in the map.
	tree.append(entry("e5", Some("e2"), MessageRole::User, vec![ContentBlock::Text {
		text: "no, change it first".to_string(),
	}]));

	let point = branch_point(&store, &session_id).expect("a prompt to fork at");
	assert_eq!(
		(point.entry, point.prompt.as_str()),
		(EntryId::from("e5"), "no, change it first"),
		"the fork point is read along the active branch, not out of the entry map"
	);
}

/// The window names an entry only where it holds the transcript. A row it has
/// never opened keeps the host's own choice rather than sending an entry id
/// the window guessed.
#[test]
fn a_transcript_the_window_has_not_loaded_names_no_entry() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-2");
	store
		.sessions
		.insert(session("sess-2", QueuePartition::Live));
	let mut index = SessionIndex::new();
	let row = index.row_of(&session_id);

	assert_eq!(
		actions_for(&Intent::BranchSession(row), &index, &mut store),
		vec![HostAction::BranchSession { session: session_id.clone(), entry: None }],
		"a session with no transcript in hand is forked at the host's own choice"
	);
	assert_eq!(
		branched_draft(&store, &index, &SurfaceId::SessionBranchButton(row_surface(row))),
		None,
		"and no text is handed back for a prompt the window never read"
	);
}

/// A session the operator has said nothing in has nothing to fork at, however
/// much the agent has written into it.
#[test]
fn a_session_with_no_prompt_of_its_own_names_no_entry() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-3");
	store
		.sessions
		.insert(session("sess-3", QueuePartition::Live));
	let tree = store.transcripts.entry(session_id.clone()).or_default();
	tree.append(entry("e1", None, MessageRole::Assistant, vec![ContentBlock::Text {
		text: "opened for you".to_string(),
	}]));
	let mut index = SessionIndex::new();
	let row = index.row_of(&session_id);

	assert_eq!(
		actions_for(&Intent::BranchSession(row), &index, &mut store),
		vec![HostAction::BranchSession { session: session_id.clone(), entry: None }],
		"a transcript holding no prompt names none"
	);
	assert_eq!(
		branched_draft(&store, &index, &SurfaceId::SessionBranchButton(row_surface(row))),
		None,
		"and hands nothing back"
	);
}

/// The draft comes back on one kind of settled request. Every other answer the
/// row menu offers settles the same way -- through `RequestSucceeded` and the
/// surface it registered under -- so a second one restoring a draft would
/// write over whatever the operator had typed since.
#[test]
fn only_a_settled_branch_hands_a_draft_back() {
	let mut store = Store::new();
	let session_id = seeded(&mut store, "sess-1");
	let mut index = SessionIndex::new();
	let row = index.row_of(&session_id);

	let restoring: Vec<&'static str> = card_row_answers(row)
		.iter()
		.filter(|answer| branched_draft(&store, &index, &answer.surface).is_some())
		.map(|answer| answer.label)
		.collect();
	assert_eq!(
		restoring,
		vec!["Branch"],
		"of the answers a row menu offers, only a branch hands the composer any text"
	);

	// The surfaces a session's own controls register under, none of which is a
	// branch: a settled request on any of them leaves the composer alone.
	for surface in [
		SurfaceId::QueueSessionRow(row_surface(row)),
		SurfaceId::ComposerSendButton(row_surface(row)),
		SurfaceId::ComposerQueuedTakeBack(row_surface(row)),
		SurfaceId::SessionRenameField(row_surface(row)),
	] {
		assert_eq!(
			branched_draft(&store, &index, &surface),
			None,
			"{surface:?} is not a branch and hands back nothing"
		);
	}
}

/// A branch reads the prompt as the transcript states it, so a prompt sent with
/// an attachment beside it comes back as its words rather than as nothing.
#[test]
fn a_prompt_sent_with_an_attachment_comes_back_as_its_words() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-4");
	store
		.sessions
		.insert(session("sess-4", QueuePartition::Live));
	let tree = store.transcripts.entry(session_id.clone()).or_default();
	tree.append(TranscriptEntry {
		content: vec![ContentBlock::Text { text: LAST_PROMPT.to_string() }, ContentBlock::Image {
			media_type: "image/png".to_string(),
			data:       vec![0],
			alt:        None,
		}],
		..entry("e1", None, MessageRole::User, Vec::new())
	});

	let point = branch_point(&store, &session_id).expect("a prompt to fork at");
	assert_eq!(
		(point.entry, point.prompt.as_str()),
		(EntryId::from("e1"), LAST_PROMPT),
		"the words come back; the picture stays in the session that holds it"
	);
}

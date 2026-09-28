//! The requests the palette sends itself, rather than a window action or a
//! command line the host parses.

use veyyon_desktop_model::{HostAction, SurfaceId, domain::ShareRole};

use super::item::{Group, Item, Run, Takes};
use crate::state::AppState;

/// The requests the palette sends itself: pausing or resuming every agent,
/// joining a share, and the open thread's own, which are reloading its
/// transcript, `/clear` (the host starts a fresh session in its place),
/// retrying the last turn, rephrasing the last reply, branching, and
/// starting, stopping, refreshing or leaving a share. A request whose
/// direction depends on state is listed only the way that applies, as the
/// thread header draws it.
pub fn requests(app: &AppState, items: &mut Vec<Item>) {
	let store = app.store();
	items.push(if store.paused.paused {
		host("Resume agents", HostAction::ResumeAgents, &["/pause", "/unpause"])
	} else {
		host("Pause agents", HostAction::PauseAgents, &["/pause"])
	});
	let role = store
		.domains
		.share
		.as_ref()
		.map_or(ShareRole::Off, |share| share.role);
	if role == ShareRole::Off {
		let join = Run::Argument {
			line:  "/join ".to_owned(),
			hint:  "<link>".to_owned(),
			takes: Takes::Link,
		};
		items.push(Item::new(Group::Commands, "Join a share…", join).also(["/join".to_owned()]));
	}
	let Some(session) = app.active_session() else {
		return;
	};
	let session = || session.clone();
	items.extend([
		host(
			"Reload the transcript",
			HostAction::LoadTranscript { session: session(), before: None },
			&["/reload-transcript"],
		),
		host("Clear the conversation", HostAction::ClearOutput { session: session() }, &["/clear"]),
		host("Retry the last turn", HostAction::RetryTurn { session: session() }, &["/retry"]),
		host("Rephrase the last reply", HostAction::RephraseReply { session: session() }, &[
			"/rephrase",
		]),
		host("Branch this thread", HostAction::BranchSession { session: session(), entry: None }, &[
			"/branch", "/fork",
		]),
	]);
	let refresh = || host("Refresh the share", HostAction::RefreshShare, &["/collab status"]);
	match role {
		ShareRole::Off => items.extend([
			host("Share thread", HostAction::StartShare { read_only: false }, &[
				"/collab",
				"/collab start",
			]),
			host("Share a read-only link", HostAction::StartShare { read_only: true }, &[
				"/collab view",
			]),
		]),
		ShareRole::Hosting => {
			items.extend([host("Stop sharing", HostAction::StopShare, &["/collab stop"]), refresh()]);
		},
		ShareRole::Guest => {
			items.extend([host("Leave the share", HostAction::LeaveShare, &["/leave"]), refresh()]);
		},
	}
}

/// A row that sends `action`, reached by its label and `spellings`.
fn host(label: &'static str, action: HostAction, spellings: &[&str]) -> Item {
	Item::new(Group::Commands, label, Run::Host(action, SurfaceId::PaletteInput))
		.also(spellings.iter().map(|spelling| (*spelling).to_owned()))
}

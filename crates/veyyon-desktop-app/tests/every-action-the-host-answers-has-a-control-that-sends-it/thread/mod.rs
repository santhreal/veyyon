//! Senders the thread header, the transcript, the session tree, the sidebar
//! and the palette draw, and the connection rows the palette lists.
//!
//! Each surface's gestures are in the child module named for it; this list
//! names each kind they send once.

mod header;
mod palette;
mod sidebar;
mod transcript;
mod tree;

use veyyon_desktop_model::HostActionKind;

use crate::Sender;

pub const SENDERS: &[Sender] = &[
	// The palette.
	Sender {
		kind:    HostActionKind::Attach,
		control: "the palette's Attach to host row",
		drive:   palette::attach,
	},
	Sender {
		kind:    HostActionKind::Detach,
		control: "the palette's Detach from host row",
		drive:   palette::detach,
	},
	Sender {
		kind:    HostActionKind::RetryConnection,
		control: "the palette's Reconnect to host row",
		drive:   palette::reconnect,
	},
	Sender {
		kind:    HostActionKind::Shutdown,
		control: "the palette's Shut down host row",
		drive:   palette::shut_down,
	},
	Sender {
		kind:    HostActionKind::ForkSession,
		control: "the palette's Fork this thread row",
		drive:   palette::fork,
	},
	Sender {
		kind:    HostActionKind::LoadTranscript,
		control: "the palette's Reload the transcript row",
		drive:   palette::reload,
	},
	Sender {
		kind:    HostActionKind::JoinShare,
		control: "the palette's Join a share row, given a link",
		drive:   palette::join,
	},
	Sender {
		kind:    HostActionKind::RefreshShare,
		control: "the palette's Refresh the share row",
		drive:   palette::refresh_share,
	},
	// The thread header.
	Sender {
		kind:    HostActionKind::PauseAgents,
		control: "the header's Pause agents button",
		drive:   header::pause,
	},
	Sender {
		kind:    HostActionKind::ResumeAgents,
		control: "the header's Resume agents button",
		drive:   header::resume,
	},
	Sender {
		kind:    HostActionKind::CompactSession,
		control: "the header's Compact context button",
		drive:   header::compact,
	},
	Sender {
		kind:    HostActionKind::ExportSession,
		control: "the header's Export as HTML button",
		drive:   header::export,
	},
	Sender {
		kind:    HostActionKind::StartShare,
		control: "the header's Share thread button",
		drive:   header::share,
	},
	Sender {
		kind:    HostActionKind::StopShare,
		control: "the header's Stop sharing button",
		drive:   header::stop_sharing,
	},
	Sender {
		kind:    HostActionKind::LeaveShare,
		control: "the header's Leave the share button",
		drive:   header::leave,
	},
	// The transcript.
	Sender {
		kind:    HostActionKind::BranchSession,
		control: "a prompt's Branch from here hover button",
		drive:   transcript::branch,
	},
	Sender {
		kind:    HostActionKind::RetryTurn,
		control: "the last reply's Retry hover button",
		drive:   transcript::retry,
	},
	Sender {
		kind:    HostActionKind::RephraseReply,
		control: "the last reply's Rephrase hover button",
		drive:   transcript::rephrase,
	},
	Sender {
		kind:    HostActionKind::OpenExternal,
		control: "a link in a reply",
		drive:   transcript::open_link,
	},
	Sender {
		kind:    HostActionKind::SetToolViewExpanded,
		control: "a tool call's row",
		drive:   transcript::open_call,
	},
	Sender {
		kind:    HostActionKind::CancelTool,
		control: "a running tool call's Cancel button",
		drive:   transcript::cancel_call,
	},
	// The session tree.
	Sender {
		kind:    HostActionKind::LoadSessionTree,
		control: "the header's Session tree button",
		drive:   tree::open,
	},
	Sender {
		kind:    HostActionKind::NavigateTree,
		control: "Enter on a session tree row, without a summary",
		drive:   tree::navigate,
	},
	Sender {
		kind:    HostActionKind::AbortBranchSummary,
		control: "Escape while the session tree's move writes its summary",
		drive:   tree::stop_summary,
	},
	Sender {
		kind:    HostActionKind::SetEntryLabel,
		control: "Shift-L's label field on a session tree row",
		drive:   tree::label,
	},
	// The sidebar.
	Sender {
		kind:    HostActionKind::OpenSession,
		control: "a click on a thread row",
		drive:   sidebar::open,
	},
	Sender {
		kind:    HostActionKind::CreateSession,
		control: "the New thread chord",
		drive:   sidebar::create,
	},
	Sender {
		kind:    HostActionKind::RenameSession,
		control: "a thread row's F2 title field",
		drive:   sidebar::rename,
	},
	Sender {
		kind:    HostActionKind::DeleteSession,
		control: "a thread row's Delete key, confirmed",
		drive:   sidebar::delete,
	},
	Sender {
		kind:    HostActionKind::HandoffSession,
		control: "the thread menu's Handoff row",
		drive:   sidebar::handoff,
	},
	Sender {
		kind:    HostActionKind::SearchSessions,
		control: "the thread search field",
		drive:   sidebar::search,
	},
	Sender {
		kind:    HostActionKind::ListSessions,
		control: "the sidebar's Refresh threads button",
		drive:   sidebar::refresh,
	},
	Sender {
		kind:    HostActionKind::CreateProfile,
		control: "the profile menu's New profile row",
		drive:   sidebar::new_profile,
	},
	Sender {
		kind:    HostActionKind::RenameProfile,
		control: "the profile menu's Rename row",
		drive:   sidebar::rename_profile,
	},
	Sender {
		kind:    HostActionKind::DeleteProfile,
		control: "the profile menu's Delete row",
		drive:   sidebar::delete_profile,
	},
	Sender {
		kind:    HostActionKind::RefreshProfiles,
		control: "the profile menu's Refresh profiles row",
		drive:   sidebar::refresh_profiles,
	},
];

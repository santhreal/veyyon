//! Senders the right panel and the terminal drawer draw.
//!
//! Each tab of the panel and each tab of the drawer asks the host for what it
//! draws when it is shown, so the gesture for a load or a refresh is the
//! operator showing that tab: the panel's chord, a palette row, a click on the
//! tab. Every other kind is a control the tab draws, reached the same way and
//! then clicked or typed into.

mod drawer;
mod right;

use veyyon_desktop_model::HostActionKind;

use crate::Sender;

pub const SENDERS: &[Sender] = &[
	// The right panel.
	Sender {
		kind:    HostActionKind::RefreshChanges,
		control: "the right panel's chord, opening it on the diff tab",
		drive:   right::refresh_changes,
	},
	Sender {
		kind:    HostActionKind::SelectChangeScope,
		control: "the diff tab's Staged scope button",
		drive:   right::select_change_scope,
	},
	Sender {
		kind:    HostActionKind::LoadFileTree,
		control: "the palette's Show files row",
		drive:   right::load_file_tree,
	},
	Sender {
		kind:    HostActionKind::ReadFile,
		control: "a file row of the files tab's tree",
		drive:   right::read_file,
	},
	Sender {
		kind:    HostActionKind::SearchContent,
		control: "the files tab's search field, on Enter",
		drive:   right::search_content,
	},
	Sender {
		kind:    HostActionKind::RefreshAgents,
		control: "the agents tab's refresh button",
		drive:   right::refresh_agents,
	},
	Sender {
		kind:    HostActionKind::ReviveAgent,
		control: "a parked agent's Revive button in the agents tab",
		drive:   right::revive_agent,
	},
	Sender {
		kind:    HostActionKind::SpawnTask,
		control: "the agents tab's spawn field, on Enter",
		drive:   right::spawn_task,
	},
	Sender {
		kind:    HostActionKind::CancelTask,
		control: "a working agent's End, confirmed by End agent, in the agents tab",
		drive:   right::cancel_task,
	},
	Sender {
		kind:    HostActionKind::PreviewSessionTranscript,
		control: "an agent's Preview button in the agents tab",
		drive:   right::preview_session_transcript,
	},
	Sender {
		kind:    HostActionKind::RefreshDiagnostics,
		control: "the right panel's Diagnostics tab",
		drive:   right::refresh_diagnostics,
	},
	Sender {
		kind:    HostActionKind::RetryDiagnosticSource,
		control: "a failed source's Retry button in the diagnostics tab",
		drive:   right::retry_diagnostic_source,
	},
	Sender {
		kind:    HostActionKind::ClearOutput,
		control: "the diagnostics tab's Clear output button",
		drive:   right::clear_output,
	},
	Sender {
		kind:    HostActionKind::GetUsage,
		control: "the palette's Show usage row",
		drive:   right::get_usage,
	},
	Sender {
		kind:    HostActionKind::GetContextBreakdown,
		control: "the right panel's Usage tab",
		drive:   right::get_context_breakdown,
	},
	// The terminal drawer.
	Sender {
		kind:    HostActionKind::CreateTerminal,
		control: "the new-terminal chord",
		drive:   drawer::create_terminal,
	},
	Sender {
		kind:    HostActionKind::AttachTerminal,
		control: "the drawer's chord, opening it on the running terminal",
		drive:   drawer::attach_terminal,
	},
	Sender {
		kind:    HostActionKind::ResizeTerminal,
		control: "the palette's Toggle terminal drawer row, laying the terminal's grid out",
		drive:   drawer::resize_terminal,
	},
	Sender {
		kind:    HostActionKind::WriteTerminal,
		control: "keys typed on the drawer's terminal grid",
		drive:   drawer::write_terminal,
	},
	Sender {
		kind:    HostActionKind::ClearTerminal,
		control: "the palette's Clear terminal row",
		drive:   drawer::clear_terminal,
	},
	Sender {
		kind:    HostActionKind::RestartTerminal,
		control: "the drawer's Restart shell button",
		drive:   drawer::restart_terminal,
	},
	Sender {
		kind:    HostActionKind::CloseTerminal,
		control: "the drawer's Close terminal button",
		drive:   drawer::close_terminal,
	},
	Sender {
		kind:    HostActionKind::RefreshProcesses,
		control: "the processes tab's refresh button",
		drive:   drawer::refresh_processes,
	},
	Sender {
		kind:    HostActionKind::ProcessStart,
		control: "the processes tab's command field and its Start button",
		drive:   drawer::process_start,
	},
	Sender {
		kind:    HostActionKind::ProcessStop,
		control: "a running process's Stop button in the processes tab",
		drive:   drawer::process_stop,
	},
	Sender {
		kind:    HostActionKind::ProcessSignal,
		control: "a running process's signal menu in the processes tab, picking Terminate",
		drive:   drawer::process_signal,
	},
	Sender {
		kind:    HostActionKind::ProcessLogs,
		control: "a process's tab in the drawer's strip",
		drive:   drawer::process_logs,
	},
	Sender {
		kind:    HostActionKind::ProcessSend,
		control: "a process tab's line field and its Send button",
		drive:   drawer::process_send,
	},
	Sender {
		kind:    HostActionKind::ProcessRestart,
		control: "a process tab's Restart button",
		drive:   drawer::process_restart,
	},
];

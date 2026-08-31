//! Host workspace file tree, change tracking, terminal, and process supervisor
//! mapping.

use crate::{
	command::UiCommand,
	host::HostAction,
	model::*,
	store::{CommandTarget, Completion, Effects, ShellEffect, Store},
};

impl Store {
	pub(super) fn map_system_action(
		&mut self,
		command: UiCommand,
		effects: &mut Effects,
	) -> Option<(HostAction, CommandTarget, Completion, Option<Capability>)> {
		match command {
			UiCommand::LoadFileTree { workspace, parent } => {
				if let Some(id) = parent.clone() {
					self.frontend.expanded_files.insert(id);
				} else {
					self.frontend.selected_workspace = Some(workspace.clone());
				}
				Some((
					HostAction::LoadFileTree { workspace, parent },
					CommandTarget::Files,
					Completion::None,
					Some(Capability::Files),
				))
			},
			UiCommand::OpenFileCursor => {
				let Some(file) = self.frontend.file_cursor.clone() else {
					effects
						.shell
						.push(ShellEffect::Notify { message: "Select a file first".to_owned() });
					return None;
				};
				self.frontend.selected_file = Some(file.clone());
				if let RemoteData::Ready(files) | RemoteData::Stale { value: files, .. } =
					&mut self.replica.files
				{
					files.value.read_error = None;
				}
				Some((
					HostAction::ReadFile { file, range: self.frontend.file_range },
					CommandTarget::Files,
					Completion::None,
					Some(Capability::Files),
				))
			},
			UiCommand::ReadFile { file, range } => {
				self.frontend.selected_file = Some(file.clone());
				self.frontend.file_range = range;
				if let RemoteData::Ready(files) | RemoteData::Stale { value: files, .. } =
					&mut self.replica.files
				{
					files.value.read_error = None;
				}
				Some((
					HostAction::ReadFile { file, range },
					CommandTarget::Files,
					Completion::None,
					Some(Capability::Files),
				))
			},
			UiCommand::SearchFiles { workspace, query, mode } => Some((
				HostAction::SearchFiles { workspace, query, mode },
				CommandTarget::Files,
				Completion::None,
				Some(Capability::Files),
			)),
			UiCommand::OpenExternal(target) => Some((
				HostAction::OpenExternal { target },
				CommandTarget::Files,
				Completion::None,
				Some(Capability::Files),
			)),
			UiCommand::RefreshChanges(scope) => Some((
				HostAction::RefreshChanges { scope },
				CommandTarget::Changes,
				Completion::None,
				Some(Capability::Changes),
			)),
			UiCommand::SetChangeBase(base) => {
				self.frontend.change_base_intent = base.clone();
				let scope = base.map_or(ChangeScope::WorkingTree, ChangeScope::Custom);
				Some((
					HostAction::SelectChangeScope { scope },
					CommandTarget::Changes,
					Completion::None,
					Some(Capability::Changes),
				))
			},
			UiCommand::SelectChangeScope(scope) => Some((
				HostAction::SelectChangeScope { scope },
				CommandTarget::Changes,
				Completion::None,
				Some(Capability::Changes),
			)),
			UiCommand::CreateTerminal { cwd } => Some((
				HostAction::CreateTerminal { cwd },
				CommandTarget::Terminals,
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::AttachTerminal(terminal) => Some((
				HostAction::AttachTerminal { terminal: terminal.clone() },
				CommandTarget::Terminal(terminal),
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::WriteTerminal { terminal, bytes } => Some((
				HostAction::WriteTerminal { terminal: terminal.clone(), bytes },
				CommandTarget::Terminal(terminal),
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::ResizeTerminal { terminal, cols, rows } => Some((
				HostAction::ResizeTerminal { terminal: terminal.clone(), cols, rows },
				CommandTarget::Terminal(terminal),
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::RestartTerminal(terminal) => Some((
				HostAction::RestartTerminal { terminal: terminal.clone() },
				CommandTarget::Terminal(terminal),
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::ClearTerminal(terminal) => Some((
				HostAction::ClearTerminal { terminal: terminal.clone() },
				CommandTarget::Terminal(terminal),
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::CloseTerminal(terminal) => Some((
				HostAction::CloseTerminal { terminal: terminal.clone() },
				CommandTarget::Terminal(terminal),
				Completion::None,
				Some(Capability::Terminals),
			)),
			UiCommand::StartProcess { spec } => Some((
				HostAction::ProcessStart { spec },
				CommandTarget::Terminals,
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::WaitProcess(process) => Some((
				HostAction::ProcessWait { process: process.clone() },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::DescribeProcess(process) => Some((
				HostAction::ProcessDescribe { process: process.clone() },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::RefreshProcesses => Some((
				HostAction::RefreshProcesses,
				CommandTarget::Terminals,
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::FetchProcessLogs { process, from_byte } => Some((
				HostAction::ProcessLogs { process: process.clone(), from_byte },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::SendProcessInput { process, text } => Some((
				HostAction::ProcessSend { process: process.clone(), text },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::SignalProcess { process, signal } => Some((
				HostAction::ProcessSignal { process: process.clone(), signal },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::StopProcess(process) => Some((
				HostAction::ProcessStop { process: process.clone() },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			UiCommand::RestartProcess(process) => Some((
				HostAction::ProcessRestart { process: process.clone() },
				CommandTarget::Process(process),
				Completion::None,
				Some(Capability::ProcessSupervisor),
			)),
			_ => None,
		}
	}
}

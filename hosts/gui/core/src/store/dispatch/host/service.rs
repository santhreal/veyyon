//! Host model catalog, MCP servers, extensions, agents, settings, and
//! diagnostic mapping.

use crate::{
	command::UiCommand,
	host::HostAction,
	model::*,
	store::{CommandTarget, Completion, Store},
};

impl Store {
	pub(super) fn map_service_action(
		&mut self,
		command: UiCommand,
	) -> Option<(HostAction, CommandTarget, Completion, Option<Capability>)> {
		match command {
			UiCommand::RefreshModels => Some((
				HostAction::RefreshModels,
				CommandTarget::Models,
				Completion::None,
				Some(Capability::Models),
			)),
			UiCommand::SelectModel { provider, model } => Some((
				HostAction::SelectModel { provider, model },
				CommandTarget::Models,
				Completion::None,
				Some(Capability::Models),
			)),
			UiCommand::SetThinkingLevel(level) => Some((
				HostAction::SetThinkingLevel { level },
				CommandTarget::Models,
				Completion::None,
				Some(Capability::Models),
			)),
			UiCommand::RefreshProviders => Some((
				HostAction::RefreshProviders,
				CommandTarget::Providers,
				Completion::None,
				Some(Capability::Providers),
			)),
			UiCommand::StartProviderAuth(provider) => {
				self.frontend.selected_provider = Some(provider.clone());
				Some((
					HostAction::StartProviderAuth { provider },
					CommandTarget::Authentication,
					Completion::None,
					Some(Capability::Authentication),
				))
			},
			UiCommand::RefreshAuth => Some((
				HostAction::RefreshAuth,
				CommandTarget::Authentication,
				Completion::None,
				Some(Capability::Authentication),
			)),
			UiCommand::SubmitAuthSecret { provider, secret } => Some((
				HostAction::SubmitAuthSecret { provider, secret },
				CommandTarget::Authentication,
				Completion::None,
				Some(Capability::Authentication),
			)),
			UiCommand::OpenAuthUrl { provider, url } => Some((
				HostAction::OpenAuthUrl { provider, url },
				CommandTarget::Authentication,
				Completion::None,
				Some(Capability::Authentication),
			)),
			UiCommand::CancelAuthFlow { provider } => Some((
				HostAction::CancelAuthFlow { provider },
				CommandTarget::Authentication,
				Completion::None,
				Some(Capability::Authentication),
			)),
			UiCommand::RetryAuthFlow { provider } => Some((
				HostAction::RetryAuthFlow { provider },
				CommandTarget::Authentication,
				Completion::None,
				Some(Capability::Authentication),
			)),
			UiCommand::RefreshMcp => Some((
				HostAction::RefreshMcp,
				CommandTarget::Mcp(None),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::ConnectMcp(server) => Some((
				HostAction::ConnectMcp { server: server.clone() },
				CommandTarget::Mcp(Some(server)),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::DisconnectMcp(server) => Some((
				HostAction::DisconnectMcp { server: server.clone() },
				CommandTarget::Mcp(Some(server)),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::SetMcpEnabled { server, enabled } => Some((
				HostAction::SetMcpEnabled { server: server.clone(), enabled },
				CommandTarget::Mcp(Some(server)),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::CallMcpTool { server, tool, arguments } => Some((
				HostAction::CallMcpTool { server: server.clone(), tool, arguments },
				CommandTarget::Mcp(Some(server)),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::ReadMcpResource { server, uri } => Some((
				HostAction::ReadMcpResource { server: server.clone(), uri },
				CommandTarget::Mcp(Some(server)),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::GetMcpPrompt { server, name, arguments } => Some((
				HostAction::GetMcpPrompt { server: server.clone(), name, arguments },
				CommandTarget::Mcp(Some(server)),
				Completion::None,
				Some(Capability::Mcp),
			)),
			UiCommand::RefreshExtensions => Some((
				HostAction::RefreshExtensions,
				CommandTarget::Extensions,
				Completion::None,
				Some(Capability::Extensions),
			)),
			UiCommand::InvokeExtensionAction { extension, action, input } => Some((
				HostAction::InvokeExtensionAction { extension, action, input },
				CommandTarget::Extensions,
				Completion::None,
				Some(Capability::Extensions),
			)),
			UiCommand::SetExtensionEnabled { extension, enabled } => Some((
				HostAction::SetExtensionEnabled { extension, enabled },
				CommandTarget::Extensions,
				Completion::None,
				Some(Capability::Extensions),
			)),
			UiCommand::SetToolEnabled { tool, enabled } => Some((
				HostAction::SetToolEnabled { tool, enabled },
				CommandTarget::Extensions,
				Completion::None,
				Some(Capability::Tools),
			)),
			UiCommand::RefreshAgents => Some((
				HostAction::RefreshAgents,
				CommandTarget::Agents,
				Completion::None,
				Some(Capability::Agents),
			)),
			UiCommand::FetchAgentTranscript { agent, from_byte } => Some((
				HostAction::FetchAgentTranscript { agent: agent.clone(), from_byte },
				CommandTarget::Agent(agent),
				Completion::None,
				Some(Capability::Agents),
			)),
			UiCommand::ChatAgent { agent, message } => Some((
				HostAction::ChatAgent { agent: agent.clone(), message },
				CommandTarget::Agent(agent),
				Completion::None,
				Some(Capability::AgentCommands),
			)),
			UiCommand::KillAgent(agent) => Some((
				HostAction::KillAgent { agent: agent.clone() },
				CommandTarget::Agent(agent),
				Completion::None,
				Some(Capability::AgentCommands),
			)),
			UiCommand::ReviveAgent(agent) => Some((
				HostAction::ReviveAgent { agent: agent.clone() },
				CommandTarget::Agent(agent),
				Completion::None,
				Some(Capability::AgentCommands),
			)),
			UiCommand::SpawnTask { agent, prompt } => Some((
				HostAction::SpawnTask { agent, prompt },
				CommandTarget::Agents,
				Completion::None,
				Some(Capability::Tasks),
			)),
			UiCommand::CancelTask(task) => Some((
				HostAction::CancelTask { task: task.clone() },
				CommandTarget::Task(task),
				Completion::None,
				Some(Capability::Tasks),
			)),
			UiCommand::LoadSettings => Some((
				HostAction::LoadSettings,
				CommandTarget::Settings(None),
				Completion::None,
				Some(Capability::Settings),
			)),
			UiCommand::SetSetting { path, value } => Some((
				HostAction::SetSetting { path: path.clone(), value },
				CommandTarget::Settings(Some(path)),
				Completion::None,
				Some(Capability::Settings),
			)),
			UiCommand::ResetSetting(path) => Some((
				HostAction::ResetSetting { path: path.clone() },
				CommandTarget::Settings(Some(path)),
				Completion::None,
				Some(Capability::Settings),
			)),
			UiCommand::LoadThemes => Some((
				HostAction::LoadThemes,
				CommandTarget::Themes,
				Completion::None,
				Some(Capability::Themes),
			)),
			UiCommand::SetTheme(id) => Some((
				HostAction::SetTheme { id },
				CommandTarget::Themes,
				Completion::None,
				Some(Capability::Themes),
			)),
			UiCommand::LoadKeybindings => Some((
				HostAction::LoadKeybindings,
				CommandTarget::Keybindings,
				Completion::None,
				Some(Capability::Keybindings),
			)),
			UiCommand::SetKeybinding { command, chord } => Some((
				HostAction::SetKeybinding { command, chord },
				CommandTarget::Keybindings,
				Completion::None,
				Some(Capability::Keybindings),
			)),
			UiCommand::RefreshDiagnostics => Some((
				HostAction::RefreshDiagnostics,
				CommandTarget::Diagnostics,
				Completion::None,
				Some(Capability::Diagnostics),
			)),
			UiCommand::RetryDiagnosticSource(source) => Some((
				HostAction::RetryDiagnosticSource { source },
				CommandTarget::Diagnostics,
				Completion::None,
				Some(Capability::Diagnostics),
			)),
			UiCommand::ClearOutput => Some((
				HostAction::ClearOutput,
				CommandTarget::Output,
				Completion::None,
				Some(Capability::Diagnostics),
			)),
			UiCommand::GetUsage => Some((
				HostAction::GetUsage,
				CommandTarget::Usage,
				Completion::None,
				Some(Capability::Usage),
			)),
			UiCommand::GetContextBreakdown => Some((
				HostAction::GetContextBreakdown,
				CommandTarget::Context,
				Completion::None,
				Some(Capability::ContextBreakdown),
			)),
			_ => None,
		}
	}
}

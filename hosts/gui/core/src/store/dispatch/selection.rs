//! Workspace, file tree, session, and diagnostic cursor navigation.

use super::toggle_set;
use crate::{
	command::UiCommand,
	model::*,
	navigation::*,
	store::{Effects, ShellEffect, Store},
};

impl Store {
	pub(super) fn dispatch_selection(&mut self, command: &UiCommand, effects: &mut Effects) -> bool {
		match command {
			UiCommand::SetSessionFilter(value) => self.frontend.session_filter = value.clone(),
			UiCommand::PinSession(id) => {
				self.frontend.pinned_sessions.insert(id.clone());
			},
			UiCommand::UnpinSession(id) => {
				self.frontend.pinned_sessions.remove(id);
			},
			UiCommand::CycleSession { forward } => self.cycle_session(*forward),
			UiCommand::SetFileFilter(value) => self.frontend.file_filter = value.clone(),
			UiCommand::SetAgentFilter(value) => self.frontend.agent_filter = value.clone(),
			UiCommand::SetSettingsFilter(value) => self.frontend.settings_filter = value.clone(),
			UiCommand::SetChangesFilter(value) => self.frontend.changes_filter = value.clone(),
			UiCommand::SetChangesTreeMode(mode) => self.frontend.changes_tree_mode = *mode,
			UiCommand::ToggleChangeFolder(path) => {
				toggle_set(&mut self.frontend.expanded_change_folders, path.clone())
			},
			UiCommand::ToggleChangeFile(file) => {
				toggle_set(&mut self.frontend.collapsed_change_files, file.clone())
			},
			UiCommand::SetReviewRange { path, range } => {
				self.frontend.review_range = range.map(|r| (path.clone(), r))
			},
			UiCommand::AddReviewComment { session, path, range, text } => {
				match self.next_attachment_id() {
					Ok(id) => self
						.frontend
						.drafts
						.entry(session.clone())
						.or_default()
						.attachments
						.push(LocalAttachment {
							id,
							kind: AttachmentKind::ReviewComment {
								path:       path.clone(),
								start_line: range.start,
								end_line:   range.end,
								text:       text.clone(),
							},
							state: AttachmentState::Selected,
						}),
					Err(error) => effects
						.shell
						.push(ShellEffect::Notify { message: error.to_string() }),
				}
			},
			UiCommand::SetProblemFilter(value) => self.frontend.problem_filter = value.clone(),
			UiCommand::ToggleProblemLevel(level) => {
				toggle_set(&mut self.frontend.problem_levels, *level)
			},
			UiCommand::SetOutputPaused(value) => self.frontend.output_paused = *value,
			UiCommand::SetOutputWrap(value) => self.frontend.output_wrap = *value,
			UiCommand::ToggleOutputLevel(level) => {
				toggle_set(&mut self.frontend.output_sources, *level)
			},
			UiCommand::SetModelQuery(value) => self.frontend.model_query = value.clone(),
			UiCommand::SetProviderQuery(value) => self.frontend.provider_query = value.clone(),
			UiCommand::SetMcpQuery(value) => self.frontend.mcp_query = value.clone(),
			UiCommand::SetExtensionQuery(value) => self.frontend.extension_query = value.clone(),
			UiCommand::SelectSession(id) => self.frontend.selected_session = Some(id.clone()),
			UiCommand::SelectEntry(id) => self.frontend.selected_entry = Some(id.clone()),
			UiCommand::SelectFile(id) => self.frontend.selected_file = Some(id.clone()),
			UiCommand::SelectAgent(id) => self.frontend.selected_agent = Some(id.clone()),
			UiCommand::SelectTerminal(id) => self.frontend.selected_terminal = Some(id.clone()),
			UiCommand::SelectWorkspace(id) => {
				self.frontend.selected_workspace = Some(id.clone());
				self.recompute_visible_files();
			},
			UiCommand::SetFileSearchMode(mode) => self.frontend.file_search_mode = *mode,
			UiCommand::MoveFileCursor { forward } => self.move_file_cursor(*forward),
			UiCommand::ToggleFileCursor => {
				if let Some(id) = &self.frontend.file_cursor {
					toggle_set(&mut self.frontend.expanded_files, id.clone());
					self.recompute_visible_files();
				}
			},
			UiCommand::SetFileRange(range) => self.frontend.file_range = *range,
			UiCommand::SelectDiagnostic(id) => self.frontend.selected_diagnostic = Some(id.clone()),
			UiCommand::SelectHunk { file, hunk } => {
				self.frontend.selected_hunk = Some((file.clone(), *hunk))
			},
			UiCommand::SetTerminalPresentation(value) => self.frontend.terminal_presentation = *value,
			UiCommand::SetTerminalSearch { terminal, query } => {
				self
					.frontend
					.terminal_search
					.insert(terminal.clone(), query.clone());
			},
			UiCommand::SetTerminalFollowTail { terminal, follow } => {
				if *follow {
					self.frontend.terminal_follow_tail.insert(terminal.clone());
				} else {
					self.frontend.terminal_follow_tail.remove(terminal);
				}
			},
			UiCommand::SplitTerminal { terminal, with, axis } => {
				self.frontend.terminal_layout = Some(TerminalLayout::Split {
					axis:        *axis,
					ratio_milli: self.frontend.terminal_split_ratio_milli,
					first:       Box::new(TerminalLayout::Leaf(terminal.clone())),
					second:      Box::new(TerminalLayout::Leaf(with.clone())),
				});
			},
			UiCommand::SetTerminalSplitRatio { ratio_milli } => {
				self.frontend.terminal_split_ratio_milli = (*ratio_milli).clamp(100, 900)
			},
			UiCommand::SetPlanReviewTab(value) => self.frontend.plan_review_tab = *value,
			UiCommand::ToggleToolDisclosure(id) => {
				toggle_set(&mut self.frontend.tool_disclosures, id.clone())
			},
			UiCommand::ToggleEntryDisclosure(id) => {
				toggle_set(&mut self.frontend.entry_disclosures, id.clone())
			},
			UiCommand::ToggleAgentExpanded(id) => {
				toggle_set(&mut self.frontend.expanded_agents, id.clone())
			},
			UiCommand::ToggleFileExpanded(id) => {
				toggle_set(&mut self.frontend.expanded_files, id.clone());
				self.recompute_visible_files();
			},
			UiCommand::NextDiagnostic { forward } => self.move_diagnostic(*forward),
			UiCommand::DismissNotice(id) => {
				if self.frontend.selected_diagnostic.as_ref() == Some(id) {
					self.frontend.selected_diagnostic = None;
				}
			},
			_ => return false,
		}
		true
	}

	pub(crate) fn cycle_session(&mut self, forward: bool) {
		let Some(versioned) = self.replica.sessions.sessions.readable() else {
			return;
		};
		if versioned.value.is_empty() {
			self.frontend.selected_session = None;
			return;
		}
		let current = self
			.frontend
			.selected_session
			.as_ref()
			.and_then(|id| versioned.value.iter().position(|session| &session.id == id))
			.unwrap_or(0);
		let next = if forward {
			(current + 1) % versioned.value.len()
		} else {
			current.checked_sub(1).unwrap_or(versioned.value.len() - 1)
		};
		self.frontend.selected_session = Some(versioned.value[next].id.clone());
	}

	pub(crate) fn move_file_cursor(&mut self, forward: bool) {
		if self.frontend.visible_files.is_empty() {
			self.frontend.file_cursor = None;
			return;
		}
		let current = self
			.frontend
			.file_cursor
			.as_ref()
			.and_then(|id| {
				self
					.frontend
					.visible_files
					.iter()
					.position(|candidate| candidate == id)
			})
			.unwrap_or(0);
		let next = if forward {
			(current + 1).min(self.frontend.visible_files.len() - 1)
		} else {
			current.saturating_sub(1)
		};
		self.frontend.file_cursor = Some(self.frontend.visible_files[next].clone());
	}

	pub(crate) fn recompute_visible_files(&mut self) {
		let Some(workspace) = self.frontend.selected_workspace.as_ref() else {
			self.frontend.visible_files.clear();
			return;
		};
		let Some(versioned) = self.replica.files.readable() else {
			self.frontend.visible_files.clear();
			return;
		};
		let mut nodes = std::collections::BTreeMap::new();
		let mut children: std::collections::BTreeMap<Option<FileId>, Vec<FileId>> =
			std::collections::BTreeMap::new();
		for node in &versioned.value.nodes {
			if &node.workspace == workspace {
				nodes.insert(node.id.clone(), node);
				children
					.entry(node.parent.clone())
					.or_default()
					.push(node.id.clone());
			}
		}
		let mut visible = Vec::new();
		if let Some(roots) = children.get(&None) {
			for root in roots {
				append_visible(root, &nodes, &children, &self.frontend.expanded_files, &mut visible);
			}
		}
		self.frontend.visible_files = visible;
	}

	pub(crate) fn move_diagnostic(&mut self, forward: bool) {
		let Some(versioned) = self.replica.diagnostics.readable() else {
			return;
		};
		let rows = &versioned.value.notices;
		if rows.is_empty() {
			self.frontend.selected_diagnostic = None;
			return;
		}
		let current = self
			.frontend
			.selected_diagnostic
			.as_ref()
			.and_then(|id| rows.iter().position(|row| &row.id == id))
			.unwrap_or(0);
		let next = if forward {
			(current + 1).min(rows.len() - 1)
		} else {
			current.saturating_sub(1)
		};
		self.frontend.selected_diagnostic = Some(rows[next].id.clone());
	}
}

fn append_visible(
	id: &FileId,
	nodes: &std::collections::BTreeMap<FileId, &FileNode>,
	children: &std::collections::BTreeMap<Option<FileId>, Vec<FileId>>,
	expanded: &std::collections::BTreeSet<FileId>,
	visible: &mut Vec<FileId>,
) {
	if !nodes.contains_key(id) {
		return;
	}
	visible.push(id.clone());
	if !expanded.contains(id) {
		return;
	}
	if let Some(descendants) = children.get(&Some(id.clone())) {
		for child in descendants {
			append_visible(child, nodes, children, expanded, visible);
		}
	}
}

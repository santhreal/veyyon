//! Dispatcher for tab strip and space management commands.

use crate::{
	command::UiCommand,
	model::{SessionId, TurnState},
	navigation::Overlay,
	store::{Effects, Store},
};

impl Store {
	pub fn is_session_dirty(&self, session: &SessionId) -> bool {
		if let Some(draft) = self.frontend.drafts.get(session)
			&& (!draft.text.trim().is_empty() || !draft.attachments.is_empty())
		{
			return true;
		}
		if let Some(runtime_ver) = self.replica.runtime.readable() {
			let runtime = &runtime_ver.value;
			if &runtime.session == session
				&& (runtime.streaming || !matches!(runtime.turn, TurnState::Idle))
			{
				return true;
			}
		}
		false
	}

	pub(super) fn dispatch_spaces(&mut self, command: &UiCommand, _effects: &mut Effects) -> bool {
		match command {
			UiCommand::OpenTab(session) => {
				self.frontend.spaces.open_tab(session.clone());
				self.frontend.selected_session = self.frontend.spaces.active_session();
				true
			},
			UiCommand::CloseTab { index, force } => {
				let session = self
					.frontend
					.spaces
					.active()
					.and_then(|s| s.tabs.get(*index).map(|t| t.session.clone()));
				if let Some(session) = session {
					if !force && self.is_session_dirty(&session) {
						self.frontend.overlays.push(Overlay::Confirmation {
							title:   "Close Tab".to_owned(),
							body:    "This session has unsent changes or an active operation. Close \
							          anyway?"
								.to_owned(),
							confirm: Box::new(UiCommand::CloseTab { index: *index, force: true }),
						});
					} else {
						self.frontend.spaces.close_tab(*index);
						self.frontend.selected_session = self.frontend.spaces.active_session();
					}
				}
				true
			},
			UiCommand::MoveTab { from, to } => {
				self.frontend.spaces.move_tab(*from, *to);
				self.frontend.selected_session = self.frontend.spaces.active_session();
				true
			},
			UiCommand::SelectTab(index) => {
				self.frontend.spaces.select_tab(*index);
				self.frontend.selected_session = self.frontend.spaces.active_session();
				true
			},
			UiCommand::CycleTabs { forward } => {
				self.frontend.spaces.cycle_tabs(*forward);
				self.frontend.selected_session = self.frontend.spaces.active_session();
				true
			},
			UiCommand::CreateSpace { name } => {
				if let Some(space) = self.frontend.spaces.active_mut() {
					space.panels = self.frontend.panels.clone();
					space.bottom_tab = self.frontend.bottom_tab;
					space.inspector_tab = self.frontend.inspector_tab;
				}
				let id = self.frontend.spaces.create_space(name.clone());
				self.frontend.spaces.select_space(&id);
				if let Some(space) = self.frontend.spaces.active() {
					self.frontend.panels = space.panels.clone();
					self.frontend.bottom_tab = space.bottom_tab;
					self.frontend.inspector_tab = space.inspector_tab;
				}
				self.frontend.selected_session = self.frontend.spaces.active_session();
				true
			},
			UiCommand::RenameSpace { id, name } => {
				self.frontend.spaces.rename_space(id, name.clone());
				true
			},
			UiCommand::CloseSpace(id) => {
				self.frontend.spaces.close_space(id);
				if let Some(space) = self.frontend.spaces.active() {
					self.frontend.panels = space.panels.clone();
					self.frontend.bottom_tab = space.bottom_tab;
					self.frontend.inspector_tab = space.inspector_tab;
				}
				self.frontend.selected_session = self.frontend.spaces.active_session();
				true
			},
			UiCommand::SelectSpace(id) => {
				if self.frontend.spaces.active_space_id() != Some(id.clone()) {
					if let Some(space) = self.frontend.spaces.active_mut() {
						space.panels = self.frontend.panels.clone();
						space.bottom_tab = self.frontend.bottom_tab;
						space.inspector_tab = self.frontend.inspector_tab;
					}
					if self.frontend.spaces.select_space(id) {
						if let Some(space) = self.frontend.spaces.active() {
							self.frontend.panels = space.panels.clone();
							self.frontend.bottom_tab = space.bottom_tab;
							self.frontend.inspector_tab = space.inspector_tab;
						}
						self.frontend.selected_session = self.frontend.spaces.active_session();
					}
				}
				true
			},
			_ => false,
		}
	}
}

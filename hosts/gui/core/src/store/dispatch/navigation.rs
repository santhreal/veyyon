//! Navigation routes, dock panels, and overlay transitions.

use crate::{
	command::UiCommand,
	navigation::*,
	store::{Effects, Store},
};

impl Store {
	pub(super) fn dispatch_navigation(
		&mut self,
		command: &UiCommand,
		effects: &mut Effects,
	) -> bool {
		match command {
			UiCommand::Navigate(route) => {
				if !matches!(route, Route::Settings(SettingsPage::Appearance)) {
					self.frontend.theme_preview = None;
				}
				self.frontend.route = *route;
			},
			UiCommand::StepSettingsPage { down } => {
				if let Route::Settings(page) = self.frontend.route {
					let pages = SettingsPage::ALL;
					let at = pages
						.iter()
						.position(|candidate| *candidate == page)
						.unwrap_or(0);
					// Stopping rather than wrapping: the nav is a list with two
					// ends on screen, and an arrow that jumped from the last row
					// to the first would read as a page that opened itself.
					let next = if *down {
						(at + 1).min(pages.len() - 1)
					} else {
						at.saturating_sub(1)
					};
					self.frontend.route = Route::Settings(pages[next]);
				}
			},
			UiCommand::SetBottomTab(tab) => {
				self.frontend.bottom_tab = *tab;
				self.frontend.panels.bottom_open = true;
			},
			UiCommand::SetInspectorTab(tab) => {
				self.frontend.inspector_tab = *tab;
				self.frontend.panels.inspector_open = true;
				self.reveal_usage(effects);
			},
			UiCommand::ToggleSidebar => {
				self.frontend.panels.sidebar_open = !self.frontend.panels.sidebar_open
			},
			UiCommand::ToggleInspector => {
				self.frontend.panels.inspector_open = !self.frontend.panels.inspector_open;
				self.reveal_usage(effects);
			},
			UiCommand::ToggleBottomDock => {
				self.frontend.panels.bottom_open = !self.frontend.panels.bottom_open
			},
			UiCommand::ResizeSidebar { width_milli_px } => {
				self.frontend.panels.sidebar_width = *width_milli_px as f32 / 1000.0
			},
			UiCommand::ResizeInspector { width_milli_px } => {
				self.frontend.panels.inspector_width = *width_milli_px as f32 / 1000.0
			},
			UiCommand::ResizeBottomDock { height_milli_px } => {
				self.frontend.panels.bottom_height = *height_milli_px as f32 / 1000.0
			},
			UiCommand::ConstrainPanels { width_milli_px, height_milli_px } => self
				.frontend
				.panels
				.constrain(*width_milli_px as f32 / 1000.0, *height_milli_px as f32 / 1000.0),
			UiCommand::OpenOverlay(overlay) => {
				// A palette opens on an empty query. Text left in the field is
				// the filter of the palette that closed, and the rows it
				// selects are that overlay's mode, so a reopened palette that
				// keeps it offers results for a filter nobody typed into it.
				if matches!(overlay.keyboard(), Some(crate::store::FocusTarget::Palette)) {
					self.frontend.palette_query.clear();
					self.frontend.palette_cursor = 0;
				}
				self.frontend.overlays.push(overlay.clone());
			},
			UiCommand::CloseTopOverlay => self.unwind_one(),
			UiCommand::CloseAllOverlays => self.frontend.overlays.clear(),
			UiCommand::SetPaletteQuery(query) => {
				self.frontend.palette_query = query.clone();
				self.frontend.palette_cursor = 0;
			},
			UiCommand::MovePaletteCursor { down } => {
				let mode = crate::palette::current_mode(self);
				let results = crate::palette::results(self, mode, &self.frontend.palette_query);
				self.frontend.palette_cursor = crate::palette::cursor::move_cursor(
					&results.groups,
					self.frontend.palette_cursor,
					*down,
				);
			},
			UiCommand::AcceptPalette => {
				let commands = crate::palette::accept(self);
				for next in commands {
					let nested = self.dispatch(next);
					effects.requests.extend(nested.requests);
					effects.shell.extend(nested.shell);
				}
			},
			_ => return false,
		}
		true
	}

	pub(crate) fn unwind_one(&mut self) {
		if self.frontend.overlays.pop().is_some() {
			return;
		}
		if self.frontend.panels.inspector_open
			&& self.frontend.panels.inspector_presentation
				== crate::navigation::PanelPresentation::Sheet
		{
			self.frontend.panels.inspector_open = false;
			return;
		}
		if self.frontend.panels.sidebar_open
			&& self.frontend.panels.sidebar_presentation == crate::navigation::PanelPresentation::Sheet
		{
			self.frontend.panels.sidebar_open = false;
			return;
		}
		if self.frontend.panels.bottom_open {
			self.frontend.panels.bottom_open = false;
			return;
		}
		if matches!(self.frontend.route, crate::navigation::Route::Settings(_)) {
			self.frontend.route = crate::navigation::Route::Conversation;
		}
	}

	/// Ask for usage as the panel that shows it is revealed, so a reader who
	/// opens the inspector reads numbers instead of a button.
	///
	/// Silent by design. Nothing asked for this request, so a host that is
	/// disconnected or does not report the capability leaves the panel's own
	/// explicit control in place rather than reporting a refusal, and a replica
	/// that already holds usage is not asked again.
	fn reveal_usage(&mut self, effects: &mut Effects) {
		if !self.frontend.panels.inspector_open
			|| self.frontend.inspector_tab != crate::navigation::InspectorTab::Context
		{
			return;
		}
		if !matches!(self.replica.usage, crate::model::RemoteData::Unrequested)
			|| self.request_pending(&crate::store::CommandTarget::Usage)
		{
			return;
		}
		if !self.connection.is_connected()
			|| !matches!(
				self.replica.capability(crate::model::Capability::Usage),
				crate::model::CapabilityStatus::Available
			) {
			return;
		}
		self.emit(
			crate::host::HostAction::GetUsage,
			crate::store::CommandTarget::Usage,
			crate::store::Completion::None,
			effects,
		);
	}
}

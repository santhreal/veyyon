//! Whether a command can run, and what running it does.
//!
//! Both are exhaustive matches over the enum, so a new variant fails to compile
//! until it states when it applies and what it changes. `applies` and `run` sit
//! together because a variant whose predicate and effect disagree is the defect
//! this pair exists to prevent.

use super::{Command, Focus, Outcome};
use crate::{
	palette,
	store::{
		model::{Store, ToolCall},
		moves,
	},
};

impl Command {
	/// Whether it can be run right now.
	///
	/// A command that cannot run is drawn faint where it is a control and left
	/// out where it is a palette row, so a reader is never offered something
	/// that does nothing.
	pub fn applies(&self, store: &Store) -> bool {
		match self {
			Command::DeleteSelected => store.selected.is_some() && store.sessions.len() > 1,
			Command::DeleteSession(id) => store.session(id).is_some() && store.sessions.len() > 1,
			Command::SelectSession(id) => store.session(id).is_some(),
			// A call with no output has nothing to open onto, so its row is drawn
			// without a disclosure rather than with one that does nothing.
			Command::ToggleTool(id) => store.tool_call(id).is_some_and(ToolCall::has_detail),
			Command::CycleSession { .. } => store.sessions.len() > 1,
			Command::ResetSidebarWidth => {
				store.settings.sidebar_open
					&& store.settings.sidebar_width != crate::store::model::SIDEBAR_DEFAULT
			},
			Command::Back => {
				store.overlay.is_open()
					|| matches!(store.route, crate::store::model::Route::Settings(_))
			},
			Command::MovePaletteCursor { .. } | Command::AcceptPalette | Command::PaletteQuery(_) => {
				store.overlay.palette().is_some()
			},
			Command::StepSettingsPage { down } => moves::settings_page_beside(store, *down).is_some(),
			Command::CloseSettings => {
				matches!(store.route, crate::store::model::Route::Settings(_))
			},
			Command::Send => store
				.selected_session()
				.is_some_and(|s| !s.draft.trim().is_empty()),
			Command::StepTextSize { up } => {
				let size = store.settings.font_size;
				if *up {
					size < crate::store::model::FONT_MAX
				} else {
					size > crate::store::model::FONT_MIN
				}
			},
			_ => true,
		}
	}

	/// Do it.
	pub fn run(self, store: &mut Store) -> Outcome {
		match self {
			Command::NewSession => {
				moves::new_session(store);
				Outcome {
					draft_changed: true,
					reveal_selection: true,
					..Outcome::focus(Focus::Composer)
				}
			},
			Command::SelectSession(id) => {
				moves::select(store, &id);
				Outcome {
					draft_changed: true,
					scroll_to_latest: true,
					reveal_selection: true,
					..Outcome::focus(Focus::Composer)
				}
			},
			Command::DeleteSelected => match store.selected.clone() {
				Some(id) => Command::DeleteSession(id).run(store),
				None => Outcome::nothing(),
			},
			Command::DeleteSession(id) => {
				moves::delete_session(store, &id);
				Outcome {
					draft_changed: true,
					reveal_selection: true,
					..Outcome::focus(Focus::Composer)
				}
			},
			Command::CycleSession { forward } => {
				moves::cycle(store, forward);
				Outcome {
					draft_changed: true,
					scroll_to_latest: true,
					reveal_selection: true,
					..Outcome::focus(Focus::Composer)
				}
			},
			Command::ToggleProject(id) => {
				moves::toggle_project(store, &id);
				Outcome::nothing()
			},
			Command::ToggleTool(id) => {
				moves::toggle_tool(store, &id);
				Outcome::nothing()
			},

			Command::ToggleSidebar => {
				moves::toggle_sidebar(store);
				Outcome::nothing()
			},
			Command::ResetSidebarWidth => {
				moves::reset_sidebar_width(store);
				Outcome::nothing()
			},
			Command::SetSidebarWidth(width) => {
				moves::set_sidebar_width(store, width);
				Outcome::nothing()
			},

			Command::OpenPalette => {
				palette::open(store);
				Outcome { reveal_selection: true, ..Outcome::focus(Focus::Palette) }
			},
			// The palette first, then the page under it. One keystroke backs out
			// of one thing at a time, which is what a reader holding Escape
			// expects: the sheet goes, then the page.
			Command::Back => {
				if store.overlay.is_open() {
					palette::close(store);
					Outcome::focus(Focus::Composer)
				} else if matches!(store.route, crate::store::model::Route::Settings(_)) {
					Command::CloseSettings.run(store)
				} else {
					Outcome::nothing()
				}
			},
			Command::MovePaletteCursor { down } => {
				palette::move_cursor(store, if down { 1 } else { -1 });
				Outcome { reveal_selection: true, ..Outcome::nothing() }
			},
			Command::PaletteQuery(query) => {
				palette::query(store, query);
				// A query puts the cursor back on the first row, and the list is
				// still where the last walk left it.
				Outcome { reveal_selection: true, ..Outcome::nothing() }
			},
			Command::AcceptPalette => {
				let taken = palette::accept(store);
				match taken {
					Some(command) => {
						let outcome = command.run(store);
						Outcome { focus: Some(Focus::Composer), ..outcome }
					},
					None => Outcome::nothing(),
				}
			},

			Command::OpenSettings(page) => {
				moves::open_settings(store, page);
				Outcome::nothing()
			},
			Command::StepSettingsPage { down } => match moves::settings_page_beside(store, down) {
				Some(page) => Command::OpenSettings(page).run(store),
				None => Outcome::nothing(),
			},
			Command::CloseSettings => {
				moves::close_settings(store);
				Outcome::focus(Focus::Composer)
			},

			Command::FlipAppearance => {
				let flipped = store.settings.appearance.flipped();
				moves::set_appearance(store, flipped);
				Outcome::nothing()
			},
			Command::SetAppearance(appearance) => {
				moves::set_appearance(store, appearance);
				Outcome::nothing()
			},
			Command::StepTextSize { up } => {
				let step = if up { 1.0 } else { -1.0 };
				moves::set_font_size(store, store.settings.font_size + step);
				Outcome::nothing()
			},
			Command::ToggleGroupByFolder => {
				moves::toggle_group_by_folder(store);
				Outcome::nothing()
			},

			// The conversation the turn landed in is `send`'s return, not an
			// outcome field: nothing outside the store acts on it while no
			// engine is attached, and a field the shell only destructures is a
			// field that goes stale before its first reader.
			Command::Send => match moves::send(store) {
				Some(_) => Outcome {
					draft_changed: true,
					scroll_to_latest: true,
					..Outcome::focus(Focus::Composer)
				},
				None => Outcome::nothing(),
			},
			Command::FocusComposer => Outcome::focus(Focus::Composer),
			Command::Quit => Outcome { quit: true, ..Outcome::default() },
		}
	}
}

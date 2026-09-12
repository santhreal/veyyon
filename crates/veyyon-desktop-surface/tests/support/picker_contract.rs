//! Picker cases are derived from the production mode, command and settings
//! registries. Exhaustive matches require new registrations to state their
//! keyboard contract.

use strum::IntoEnumIterator;
use veyyon_desktop_scene::session::HeadlessSession;
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteState, ShellView,
	navigation::SurfaceRoute,
	palette::{
		PaletteItem, PaletteItemKind, PaletteMode,
		commands::{ComposerCommand, command_items},
	},
	settings::SettingsPage,
};
use veyyon_gpui::{Context, Window};

#[derive(Debug, Clone, Copy)]
pub enum Source {
	Mode(PaletteMode),
	Composer(ComposerCommand),
	Route(SurfaceRoute),
	History,
	Themes,
}

pub fn sources() -> Vec<Source> {
	let mut sources: Vec<_> = PaletteMode::iter().map(Source::Mode).collect();
	let mut composer_actions = Vec::new();
	for command in ComposerCommand::iter() {
		match command {
			ComposerCommand::Models | ComposerCommand::Effort | ComposerCommand::QueueMode => {
				sources.push(Source::Composer(command));
			},
			ComposerCommand::AttachFiles | ComposerCommand::Steer | ComposerCommand::Queue => {
				composer_actions.push(command);
			},
		}
	}
	assert_eq!(composer_actions, vec![
		ComposerCommand::AttachFiles,
		ComposerCommand::Steer,
		ComposerCommand::Queue
	]);
	let mut dialogs = Vec::new();
	for page in SettingsPage::iter() {
		match page {
			SettingsPage::Themes => sources.push(Source::Themes),
			SettingsPage::General
			| SettingsPage::Keybindings
			| SettingsPage::Providers
			| SettingsPage::Authentication
			| SettingsPage::Mcp
			| SettingsPage::Extensions
			| SettingsPage::Diagnostics
			| SettingsPage::Usage
			| SettingsPage::ContextBreakdown => dialogs.push(page),
		}
	}
	assert_eq!(dialogs, vec![
		SettingsPage::General,
		SettingsPage::Keybindings,
		SettingsPage::Providers,
		SettingsPage::Authentication,
		SettingsPage::Mcp,
		SettingsPage::Extensions,
		SettingsPage::Diagnostics,
		SettingsPage::Usage,
		SettingsPage::ContextBreakdown
	]);
	let mut routes = Vec::new();
	for item in command_items() {
		if let PaletteItemKind::Command { intent } = item.kind {
			match *intent {
				Intent::Navigate(route) => match route {
					SurfaceRoute::Commands | SurfaceRoute::Account | SurfaceRoute::Settings => {
						if !routes.contains(&route) {
							routes.push(route);
						}
					},
					SurfaceRoute::Page(_) => {},
				},
				Intent::FindSessions(_) => sources.push(Source::History),
				_ => {},
			}
		}
	}
	assert!(
		sources
			.iter()
			.any(|source| matches!(source, Source::History)),
		"the history command is registered"
	);
	sources.extend(routes.into_iter().map(Source::Route));
	sources
}

pub fn open(
	source: Source,
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) {
	view.open_command_palette(window, cx);
	match source {
		Source::Mode(mode) => {
			let mut state = match mode {
				PaletteMode::Commands => PaletteState::commands(),
				PaletteMode::Sessions => PaletteState::from_sessions(&view.state().sections),
				PaletteMode::Models => PaletteState::from_models(
					view
						.state()
						.composer
						.model
						.as_ref()
						.expect("fixture models"),
				),
				PaletteMode::Files | PaletteMode::ContentSearch | PaletteMode::Browse => {
					PaletteState::new(mode)
				},
			};
			match mode {
				PaletteMode::Files => state.set_items(vec![PaletteItem::file(1, "src/app.rs")]),
				PaletteMode::ContentSearch => {
					state.set_items(vec![PaletteItem::content_match(
						1,
						"src/app.rs",
						2,
						"let app = 1;",
					)]);
				},
				PaletteMode::Browse => state.set_items(vec![PaletteItem::directory(1, "src")]),
				PaletteMode::Commands | PaletteMode::Sessions | PaletteMode::Models => {},
			}
			view.state_mut().overlay = Some(Overlay::Palette(state));
		},
		Source::Composer(command) => {
			let index = view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.unwrap()
				.filtered_items()
				.iter()
				.position(
					|item| matches!(item.kind, PaletteItemKind::Composer { command: held } if held == command),
				)
				.expect("registered composer row");
			view.picker_pointer(index, true, cx);
		},
		Source::Route(route) => view.navigate_surface(route, cx),
		Source::History => {
			let index = view.state().overlay.as_ref().and_then(Overlay::as_palette).unwrap().filtered_items()
				.iter().position(|item| matches!(&item.kind, PaletteItemKind::Command { intent } if matches!(intent.as_ref(), Intent::FindSessions(_)))).expect("registered history row");
			view.picker_pointer(index, true, cx);
			assert_eq!(view.drain_intents(), vec![Intent::FindSessions(String::new())]);
			let mut state = PaletteState::history(String::new());
			state.set_host_items(vec![PaletteItem::command(
				1,
				"A different title",
				Intent::PreviewSession("history/session.jsonl".into()),
				None,
			)]);
			view.state_mut().overlay = Some(Overlay::Palette(state));
		},
		Source::Themes => {
			view.navigate_surface(SurfaceRoute::Page(SettingsPage::Themes), cx);
		},
	}
	if let Some(palette) = view
		.state_mut()
		.overlay
		.as_mut()
		.and_then(Overlay::as_palette_mut)
	{
		let row = (*palette
			.filtered_items()
			.first()
			.expect("source supplied a selectable row"))
		.clone();
		let rows = (0..12)
			.map(|index| {
				let mut row = row.clone();
				row.id = index + 1;
				row.title = format!("Picker choice {index}");
				row
			})
			.collect();
		palette.set_items(rows);
	}
	view.drain_intents();
}

pub fn selection(overlay: &Overlay) -> usize {
	match overlay {
		Overlay::Palette(state) => state.selected,
		Overlay::Settings(state) => {
			assert_eq!(
				state.page,
				SettingsPage::Themes,
				"non-picker settings pages are not list selectors"
			);
			state.selected_row.unwrap_or(0)
		},
		Overlay::History(_) => panic!("read-only transcript preview is not a picker"),
	}
}

pub fn navigate(session: &mut HeadlessSession<'_, ShellView>, source: Source) {
	let count = session
		.update(|view, _, cx| match view.state().overlay.as_ref().unwrap() {
			Overlay::Palette(palette) => palette.filtered_items().len(),
			Overlay::Settings(_) => cx
				.try_global::<veyyon_desktop_surface::ThemeLibrary>()
				.unwrap()
				.themes()
				.len(),
			Overlay::History(_) => panic!("preview is not a picker"),
		})
		.unwrap();
	assert!(count > 1, "{source:?}: keyboard boundary needs multiple rows");
	for (key, expected) in [
		("home", 0),
		("up", count - 1),
		("down", 0),
		("pagedown", 8.min(count - 1)),
		("end", count - 1),
		("pageup", (count - 1).saturating_sub(8)),
		("home", 0),
	] {
		session.frame().expect("dispatch tree");
		assert!(session.keystroke(key).unwrap(), "{source:?}: {key} handled");
		session
			.update(|view, _, cx| {
				assert_eq!(
					selection(view.state().overlay.as_ref().unwrap()),
					expected,
					"{source:?}: {key}"
				);
				assert_eq!(view.composer_text(), "retained draft");
				if matches!(source, Source::Themes) {
					let library = cx
						.try_global::<veyyon_desktop_surface::ThemeLibrary>()
						.unwrap();
					assert_eq!(
						view.state().appearance.previewed(),
						Some(library.themes()[expected].appearance.as_str())
					);
				}
			})
			.unwrap();
	}
}

pub fn no_matches(session: &mut HeadlessSession<'_, ShellView>) {
	session
		.update(|view, _, _| {
			if let Some(palette) = view
				.state_mut()
				.overlay
				.as_mut()
				.and_then(Overlay::as_palette_mut)
			{
				if palette.is_history() {
					palette.set_host_items(Vec::new());
				} else {
					palette.set_query("zzzzzz-no-such-item");
				}
				assert!(palette.selected_item().is_none());
			}
		})
		.unwrap();
	session.frame().unwrap();
	session.keystroke("enter").unwrap();
	session
		.update(|view, _, _| {
			assert!(view.state().overlay.is_some(), "no-match confirmation cannot close");
			assert!(view.drain_intents().is_empty(), "no-match confirmation cannot run");
		})
		.unwrap();
}

pub fn confirmation(view: &ShellView, cx: &Context<ShellView>) -> (String, Intent) {
	match view.state().overlay.as_ref().unwrap() {
		Overlay::Palette(palette) => {
			let item = palette.selected_item().expect("selected row");
			let intent = match &item.kind {
				PaletteItemKind::Directory { path } => Intent::BrowseTo { path: Some(path.clone()) },
				_ => palette.run_intent().expect("an action row has an intent"),
			};
			(item.title.clone(), intent)
		},
		Overlay::Settings(state) => {
			assert_eq!(state.page, SettingsPage::Themes);
			let library = cx
				.try_global::<veyyon_desktop_surface::ThemeLibrary>()
				.unwrap();
			let theme = &library.themes()[state.selected_row.unwrap_or(0)];
			(theme.name.clone(), Intent::SelectAppearance(theme.appearance.clone()))
		},
		Overlay::History(_) => panic!("preview is not a picker"),
	}
}

pub fn confirmed(expected: &Intent, reported: &[Intent], view: &ShellView) {
	match expected {
		Intent::Navigate(route) => {
			assert_eq!(view.state().overlay.as_ref().and_then(Overlay::route), Some(*route));
		},
		Intent::SelectAppearance(appearance) => {
			assert_eq!(view.state().appearance.chosen(), appearance);
			assert!(view.state().appearance.previewed().is_none());
		},
		Intent::BrowseTo { path } => {
			assert_eq!(reported, std::slice::from_ref(expected));
			assert_eq!(
				view
					.state()
					.overlay
					.as_ref()
					.and_then(Overlay::as_palette)
					.unwrap()
					.browse_root(),
				path.as_deref()
			);
		},
		Intent::PreviewSession(session) => {
			assert_eq!(reported, std::slice::from_ref(expected));
			let Some(Overlay::History(preview)) = view.state().overlay.as_ref() else {
				panic!("selecting history opens its read-only preview");
			};
			assert_eq!(&preview.session, session);
			assert!(preview.loading, "the selected session is awaiting its transcript");
		},
		_ => {
			assert_eq!(reported, std::slice::from_ref(expected));
			assert!(view.state().overlay.is_none());
		},
	}
}

/// Samples inner padding directly above the title, including rows without a
/// left inset.
pub fn row_fill(
	frame: &veyyon_desktop_scene::headless::Captured,
	title: &str,
) -> veyyon_desktop_scene::frame::RgbaColor {
	let run = frame
		.text_runs
		.iter()
		.rev()
		.find(|run| run.text.as_ref() == title)
		.expect("row title rendered");
	let x = (f32::from(run.bounds.origin.x) + 1.0).floor() as u32;
	let y = (f32::from(run.bounds.origin.y) - 2.0).floor() as u32;
	frame
		.frame
		.pixel(x, y)
		.expect("row padding is inside the window")
}

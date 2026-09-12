//! Menu-bar sections share picker confirmation, availability and horizontal
//! navigation.

use strum::IntoEnumIterator;
use veyyon_desktop_surface::{
	Intent, Overlay, fixture,
	keymap::Command,
	menu::{MenuSectionId, MenuSource},
	palette::PaletteMode,
};
use veyyon_gpui::Point;

use super::menu_picker_contract::{Source, open};

#[test]
fn every_bar_section_confirms_through_its_existing_command_dispatch() {
	for section in MenuSectionId::iter() {
		let command = match section {
			MenuSectionId::Veyyon => Command::OpenPalette,
			MenuSectionId::Session => Command::NewSession,
			MenuSectionId::View => Command::ToggleQueue,
			MenuSectionId::Edit => Command::CopySelection,
			MenuSectionId::Turn => Command::AbortTurn,
		};
		assert_eq!(section.entries()[0], command, "classify a changed section entry");
		for pointer in [false, true] {
			super::render_session(fixture::populated(), |session| {
				let (collapsed, copied) = session
					.update(|view, window, cx| {
						open(Source::Bar(section), view, window, cx);
						(view.state().keymap.queue_collapsed, view.selected_text())
					})
					.unwrap();
				let frame = session.frame().unwrap();
				if pointer {
					let run = frame
						.text_runs
						.iter()
						.rev()
						.find(|run| run.text.as_ref() == command.label())
						.expect("bar entry rendered");
					session
						.click(Point {
							x: run.bounds.origin.x + run.bounds.size.width / 2.0,
							y: run.bounds.origin.y + run.bounds.size.height / 2.0,
						})
						.unwrap();
				} else {
					session.keystroke("enter").unwrap();
				}
				session.frame().unwrap();
				session
					.update(|view, _, cx| {
						assert!(view.active_menu_source().is_none());
						assert_eq!(view.composer_text(), "retained draft");
						match section {
							MenuSectionId::Veyyon => assert_eq!(
								view
									.state()
									.overlay
									.as_ref()
									.and_then(Overlay::as_palette)
									.unwrap()
									.mode,
								PaletteMode::Commands
							),
							MenuSectionId::Session => {
								assert_eq!(view.drain_intents(), vec![Intent::NewSession]);
							},
							MenuSectionId::View => {
								assert_eq!(view.state().keymap.queue_collapsed, !collapsed);
							},
							MenuSectionId::Edit => {
								assert!(!copied.is_empty());
								assert_eq!(
									cx.read_from_clipboard().and_then(|item| item.text()),
									Some(copied)
								);
							},
							MenuSectionId::Turn => {
								assert_eq!(view.drain_intents(), vec![Intent::AbortTurn]);
							},
						}
					})
					.unwrap();
			});
		}
	}
}

#[test]
fn withdrawn_bar_commands_are_skipped_and_never_activated() {
	for section in MenuSectionId::iter() {
		super::render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					open(Source::Bar(section), view, window, cx);
					view.state_mut().menu.declined =
						section.entries()[..section.entries().len() - 1].to_vec();
				})
				.unwrap();
			let title = section.entries().last().unwrap().label();
			let neutral = super::picker_contract::row_fill(&session.frame().unwrap(), title);
			for key in ["home", "up", "down", "pageup", "pagedown", "end"] {
				session.frame().unwrap();
				session.keystroke(key).unwrap();
				session
					.update(|view, _, _| {
						assert_eq!(view.state().menu.highlighted, section.entries().len() - 1);
					})
					.unwrap();
			}
			assert_ne!(super::picker_contract::row_fill(&session.frame().unwrap(), title), neutral);
			session
				.update(|view, _, cx| {
					view.state_mut().menu.declined = section.entries().to_vec();
					cx.notify();
				})
				.unwrap();
			assert_eq!(super::picker_contract::row_fill(&session.frame().unwrap(), title), neutral);
			session.keystroke("enter").unwrap();
			session
				.update(|view, window, cx| {
					for index in 0..section.entries().len() {
						view.menu_picker_pointer(MenuSource::Bar, index, window, cx);
					}
					assert_eq!(view.state().menu.open, Some(section));
					assert!(view.drain_intents().is_empty());
					assert!(view.state().overlay.is_none());
					assert_eq!(view.composer_text(), "retained draft");
				})
				.unwrap();
			session.keystroke("escape").unwrap();
			session
				.update(|view, _, _| assert!(view.active_menu_source().is_none()))
				.unwrap();
		});
	}
}

#[test]
fn menu_sections_use_horizontal_arrows_without_running_the_highlight() {
	let sections: Vec<_> = MenuSectionId::iter().collect();
	for (index, section) in sections.iter().copied().enumerate() {
		super::render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					open(Source::Bar(section), view, window, cx);
				})
				.unwrap();
			for (key, expected) in
				[("right", sections[(index + 1) % sections.len()]), ("left", section)]
			{
				session.frame().unwrap();
				session.keystroke(key).unwrap();
				session
					.update(|view, _, _| {
						assert_eq!(view.state().menu.open, Some(expected));
						assert_eq!(view.state().menu.highlighted, 0);
						assert!(view.drain_intents().is_empty());
					})
					.unwrap();
			}
		});
	}
}

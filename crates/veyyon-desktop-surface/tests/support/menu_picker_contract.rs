//! WHY: Menu lists must share the picker key and focus contract instead of
//! trapping arrows in the editor or dispatching a different action on Return.
//! Cases come from every menu source, bar section and queue partition registry.
//! GAPS: Platform key delivery and host execution are integration checks.

use strum::IntoEnumIterator;
use veyyon_desktop_kit::MenuItem;
use veyyon_desktop_surface::{
	Intent, ShellView,
	composer::TurnPhase,
	drawer::{SignalMenu, signal_menu_items},
	fixture,
	menu::{MenuSectionId, MenuSource},
	queue::{RowMenu, RowMenuKind, row_menu_items},
	transcript::{TurnMenu, turn_menu_items},
};
use veyyon_gpui::{Context, Point, Window, px};

#[derive(Debug, Clone, Copy)]
pub enum Source {
	Bar(MenuSectionId),
	Queue(RowMenuKind),
	Turn(bool),
	Signal,
}

impl Source {
	const fn registry(self) -> MenuSource {
		match self {
			Self::Bar(_) => MenuSource::Bar,
			Self::Queue(_) => MenuSource::Queue,
			Self::Turn(_) => MenuSource::Turn,
			Self::Signal => MenuSource::Signal,
		}
	}
}

fn sources() -> Vec<Source> {
	let mut sources = Vec::new();
	for source in MenuSource::iter() {
		match source {
			MenuSource::Bar => sources.extend(MenuSectionId::iter().map(Source::Bar)),
			MenuSource::Queue => sources.extend(RowMenuKind::iter().map(|kind| match kind {
				RowMenuKind::Card
				| RowMenuKind::Pinned
				| RowMenuKind::Parked
				| RowMenuKind::Deferred => Source::Queue(kind),
			})),
			MenuSource::Turn => sources.extend([Source::Turn(false), Source::Turn(true)]),
			MenuSource::Signal => sources.push(Source::Signal),
		}
	}
	sources
}

pub fn open(
	source: Source,
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) -> Vec<(MenuItem, Option<Intent>)> {
	view.set_composed("retained draft", cx);
	let focus = view.ensure_composer(cx).read(cx).focus_handle().clone();
	window.focus(&focus, cx);
	open_menu(source, view, window, cx)
}

fn open_menu(
	source: Source,
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) -> Vec<(MenuItem, Option<Intent>)> {
	let origin = Point { x: px(500.0), y: px(160.0) };
	let rows = match source {
		Source::Bar(section) => {
			view.select_whole_entry(0);
			view.state_mut().turn =
				TurnPhase::Running { queue_mode: view.state().composer.queue_mode };
			view.toggle_menu_section(Some(section), window, cx);
			section
				.entries()
				.iter()
				.map(|command| {
					(MenuItem::new(command.label()).disabled(!view.state().menu.enabled(*command)), None)
				})
				.collect()
		},
		Source::Queue(kind) => {
			let menu = RowMenu { id: view.state().current_id, origin, kind };
			let rows = row_menu_items(&menu, &view.state().controls);
			view.open_row_menu(menu);
			rows
				.into_iter()
				.map(|(row, intent)| (row, Some(intent)))
				.collect()
		},
		Source::Turn(forkable) => {
			let menu = TurnMenu { turn: 0, origin, text: "copied prompt".into(), forkable };
			let rows = turn_menu_items(&menu);
			view.open_turn_menu(menu);
			rows
				.into_iter()
				.map(|(row, intent)| (row, Some(intent)))
				.collect()
		},
		Source::Signal => {
			let menu = SignalMenu { process: "worker".into(), origin };
			let rows = signal_menu_items(&menu);
			view.open_signal_menu(menu);
			rows
				.into_iter()
				.map(|(row, intent)| (row, Some(intent)))
				.collect()
		},
	};
	view.drain_intents();
	cx.notify();
	rows
}

#[test]
fn every_registered_menu_walks_boundaries_and_restores_the_original_editor() {
	for source in sources() {
		super::render_session(fixture::populated(), |session| {
			let rows = session
				.update(|view, window, cx| open(source, view, window, cx))
				.unwrap();
			assert!(
				rows
					.iter()
					.all(|(row, _)| !row.is_disabled && !row.is_separator),
				"fixture offers {source:?}"
			);
			let count = rows.len();
			for (key, selected) in [
				("home", 0),
				("up", count - 1),
				("down", 0),
				("pagedown", 8.min(count - 1)),
				("end", count - 1),
				("pageup", (count - 1).saturating_sub(8)),
				("home", 0),
			] {
				session.frame().unwrap();
				session.keystroke(key).unwrap();
				session
					.update(|view, _, _| {
						assert_eq!(
							view.menu_picker_selection(source.registry()),
							selected,
							"{source:?}: {key}"
						);
						assert_eq!(view.composer_text(), "retained draft");
						assert!(view.drain_intents().is_empty(), "navigation cannot activate a row");
					})
					.unwrap();
			}
			session.keystroke("escape").unwrap();
			session.frame().unwrap();
			session
				.update(|view, window, cx| {
					assert!(
						view.active_menu_source().is_none(),
						"{source:?}: one Escape closes the menu"
					);
					assert_eq!(view.composer_text(), "retained draft");
					assert!(
						view
							.ensure_composer(cx)
							.read(cx)
							.focus_handle()
							.is_focused(window),
						"{source:?}: editor focus returned"
					);
				})
				.unwrap();
		});
	}
}

#[test]
fn every_context_menu_row_confirms_its_registered_action_by_pointer_and_enter() {
	for source in sources()
		.into_iter()
		.filter(|source| !matches!(source, Source::Bar(_)))
	{
		let count = super::render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| open(source, view, window, cx).len())
				.unwrap()
		});
		for index in 0..count {
			for pointer in [false, true] {
				super::render_session(fixture::populated(), |session| {
					let (row, expected) = session
						.update(|view, window, cx| open(source, view, window, cx).remove(index))
						.unwrap();
					session.frame().unwrap();
					session.keystroke("home").unwrap();
					for _ in 0..index {
						session.frame().unwrap();
						session.keystroke("down").unwrap();
					}
					let frame = session.frame().unwrap();
					if pointer {
						let run = frame
							.text_runs
							.iter()
							.rev()
							.find(|run| run.text.as_ref() == row.label.as_ref())
							.expect("menu row rendered");
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
						.update(|view, window, cx| {
							assert!(
								view.active_menu_source().is_none(),
								"{source:?}: confirmation closes"
							);
							assert_eq!(view.composer_text(), "retained draft");
							match expected.unwrap() {
								Intent::CopyText(text) => {
									assert_eq!(
										cx.read_from_clipboard().and_then(|item| item.text()),
										Some(text)
									);
									assert!(view.drain_intents().is_empty());
								},
								intent => assert_eq!(
									view.drain_intents(),
									vec![intent],
									"{source:?}: registered domain action"
								),
							}
							assert!(
								view
									.ensure_composer(cx)
									.read(cx)
									.focus_handle()
									.is_focused(window)
							);
						})
						.unwrap();
				});
			}
		}
	}
}

#[test]
fn menus_over_a_palette_retain_its_query_selection_and_focus() {
	for source in sources() {
		super::render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					view.set_composed("retained draft", cx);
					view.open_command_palette(window, cx);
				})
				.unwrap();
			session.frame().unwrap();
			session.type_text("model").unwrap();
			session.frame().unwrap();
			let before = session
				.update(|view, window, cx| {
					let palette = view.state().overlay.clone();
					open_menu(source, view, window, cx);
					palette
				})
				.unwrap();
			session.frame().unwrap();
			session.keystroke("down").unwrap();
			session.keystroke("home").unwrap();
			session.keystroke("escape").unwrap();
			session.frame().unwrap();
			session
				.update(|view, window, cx| {
					assert!(view.active_menu_source().is_none(), "{source:?}");
					assert_eq!(view.state().overlay, before, "{source:?}: covered picker is unchanged");
					let entity = view.palette_editor().expect("palette input retained");
					let editor = entity.read(cx);
					assert_eq!(editor.text(), "model");
					assert!(editor.focus_handle().is_focused(window));
					assert_eq!(view.composer_text(), "retained draft");
					assert!(view.drain_intents().is_empty());
				})
				.unwrap();
		});
	}
}

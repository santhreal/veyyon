//! WHY: a native take of `proof/scenes/desktop-rail-footer.sh` pressed the rail
//! footer's gear, which opens `SurfaceRoute::Settings` directly, and then
//! pressed Escape to get back to the transcript. The window did not return: it
//! opened the command palette, half a million pixels away from the frame the
//! gear was pressed in. `back_surface` ascended through
//! `SurfaceRoute::parent()`, a static table that states where a route sits in
//! the command hierarchy, and read it as where the operator had been. The
//! header drew a `Back` control by the same table, so the pointer path offered
//! a way back to a surface that had never been opened either.
//!
//! THE CLASS THIS CLOSES: an ascent, by key or by control, that lands on a
//! surface the operator never visited. Every route is swept at run time -- the
//! three roots and one for every `SettingsPage` -- and each is entered three
//! ways: directly, descended one step from the command palette, and descended
//! the whole group chain. The expected destination is derived from the path
//! that was walked, so a route whose table parent differs from the palette it
//! was reached through (`Page(Keybindings)` opened straight from `Commands`)
//! fails an implementation that consults the table. The pages come from
//! `SettingsPage::iter()` and the roots from an exhaustive match, so a new page
//! joins the sweep by existing and a fifth kind of route stops this compiling.
//! The chrome is read in the same frames: a directly opened surface registers
//! exactly one hit rect fewer than the same surface descended into, which is
//! the `Back` control that must not be offered, and the words the surface drew
//! state the same thing -- footer hints on a palette, header controls on a
//! card. The words are compared as the frame recorded them, not as a shaped
//! width, because a width is a value any other run in the frame can hold.
//!
//! WHAT IT DOES NOT CATCH: the browsed-directory ascent inside
//! `PaletteMode::Browse`, which `a-browse-row-lists-the-directory-it-opened`
//! owns; which focus the composer regains once the last surface closes, owned
//! by `a-row-that-opens-a-lookup-hands-it-the-keyboard`; and the X11 recorder's
//! own key delivery, which no in-process suite reaches.

use std::path::Path;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Keymap, Overlay, SettingsPage, ShellState, ShellView, fixture, install_tokens,
	navigation::SurfaceRoute,
};
use veyyon_gpui::{App, AppContext};

fn render_session<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");
	test(&mut session)
}

/// Every surface the command hierarchy reaches. The pages are read from
/// `SettingsPage` at run time, and the match is exhaustive, so a fifth kind of
/// route states how it is reached before this compiles.
fn routes() -> Vec<SurfaceRoute> {
	let mut routes = vec![
		SurfaceRoute::Commands,
		SurfaceRoute::Account,
		SurfaceRoute::Settings,
		SurfaceRoute::Agents,
		SurfaceRoute::Share,
	];
	routes.extend(SettingsPage::iter().map(SurfaceRoute::Page));
	for route in &routes {
		match route {
			SurfaceRoute::Commands
			| SurfaceRoute::Account
			| SurfaceRoute::Settings
			| SurfaceRoute::Agents
			| SurfaceRoute::Share
			| SurfaceRoute::Page(_) => {},
		}
	}
	routes
}

/// The four ways a surface is reached, which differ only in what the operator
/// walked through to get there.
#[derive(Debug, Clone, Copy, EnumIter)]
enum Way {
	/// The rail footer's gear, a slash command, a keybinding: one navigation,
	/// nothing above it.
	Directly,
	/// The same command issued twice over, which opens the surface already on
	/// screen and puts nothing above it either.
	TwiceOver,
	/// One descent from the command palette, whatever the route table says the
	/// surface sits under.
	FromCommands,
	/// Every group the route table puts between the palette and the surface.
	DownTheGroups,
}

/// The navigations a way performs, in order, ending at `route`. `None` when the
/// way does not reach that route: the command palette is not descended into
/// from itself.
fn path(way: Way, route: SurfaceRoute) -> Option<Vec<SurfaceRoute>> {
	match way {
		Way::Directly => Some(vec![route]),
		Way::TwiceOver => Some(vec![route, route]),
		Way::FromCommands => {
			(route != SurfaceRoute::Commands).then(|| vec![SurfaceRoute::Commands, route])
		},
		Way::DownTheGroups => {
			let mut chain = vec![route];
			while let Some(parent) = chain.last().copied().and_then(SurfaceRoute::parent) {
				chain.push(parent);
			}
			chain.reverse();
			(chain.len() > 2).then_some(chain)
		},
	}
}

/// The surfaces the walk leaves standing above one another: a navigation to the
/// surface already open opens no second one, so a repeat is one rung.
fn ladder(walked: &[SurfaceRoute]) -> Vec<SurfaceRoute> {
	let mut rungs: Vec<SurfaceRoute> = Vec::with_capacity(walked.len());
	for route in walked.iter().copied() {
		if rungs.last() != Some(&route) {
			rungs.push(route);
		}
	}
	rungs
}

/// Walks a path and returns the frame the last surface drew.
fn walk(session: &mut HeadlessSession<ShellView>, walked: &[SurfaceRoute]) -> Captured {
	session.frame().expect("first frame");
	for (step, route) in walked.iter().enumerate() {
		let route = *route;
		session
			.update(move |view, window, cx| {
				if step == 0 && route == SurfaceRoute::Commands {
					view.open_command_palette(window, cx);
				} else {
					view.navigate_surface(route, cx);
				}
			})
			.expect("the surface opens");
		session.frame().expect("frame after the navigation");
	}
	session.frame().expect("frame of the surface reached")
}

/// What the frame is showing: nothing at all, or a surface and the route it
/// carries.
#[derive(Debug, PartialEq, Eq)]
enum Shown {
	Nothing,
	Surface(Option<SurfaceRoute>),
	History,
}

fn shown(session: &mut HeadlessSession<ShellView>) -> Shown {
	session
		.update(|view, _window, _cx| match view.state().overlay.as_ref() {
			Some(
				overlay @ (Overlay::Palette(_)
				| Overlay::Settings(_)
				| Overlay::Agents(_)
				| Overlay::Share(_)),
			) => Shown::Surface(overlay.route()),
			Some(Overlay::History(_)) => Shown::History,
			None => Shown::Nothing,
		})
		.expect("the overlay is readable")
}

#[test]
fn an_escape_returns_to_the_surface_the_operator_came_from() {
	let routes = routes();
	assert!(routes.len() > 3, "the hierarchy carries pages under its roots");
	for way in Way::iter() {
		for route in routes.iter().copied() {
			let Some(walked) = path(way, route) else {
				continue;
			};
			let case = format!("{way:?} {}", route.title());
			render_session(fixture::populated(), |session| {
				walk(session, &walked);
				assert_eq!(
					shown(session),
					Shown::Surface(Some(route)),
					"{case}: the walk ends on the surface it asked for"
				);

				// Ascend once per rung the walk left standing. Each Escape lands
				// on the rung below it, and the last one closes rather than
				// opening the route table's parent of the first surface, or the
				// surface already on screen.
				for expected in ladder(&walked).iter().rev().skip(1).copied() {
					session
						.update(|view, _window, _cx| {
							assert_eq!(
								view.back_route(),
								Some(expected),
								"{case}: the way back is the step before this one"
							);
						})
						.expect("the way back is readable");
					assert!(
						session.keystroke("escape").expect("escape dispatched"),
						"{case}: the escape key reached a handler"
					);
					session.frame().expect("frame after the ascent");
					assert_eq!(
						shown(session),
						Shown::Surface(Some(expected)),
						"{case}: the ascent lands where the operator came from"
					);
				}

				session
					.update(|view, _window, _cx| {
						assert_eq!(
							view.back_route(),
							None,
							"{case}: nothing sits above the surface that was entered first"
						);
					})
					.expect("the way back is readable");
				assert!(
					session.keystroke("escape").expect("escape dispatched"),
					"{case}: the escape key reached a handler"
				);
				session.frame().expect("frame after the last ascent");
				assert_eq!(
					shown(session),
					Shown::Nothing,
					"{case}: the first surface entered closes instead of opening another"
				);
			});
		}
	}
}

/// Where a surface states the way out. A palette prints it as a footer hint
/// beside the key that performs it; a card -- the settings sheet, the agent
/// dashboard, the share card -- draws it as a header control. Which one a
/// route uses is read off the overlay the walk left open, so a route that
/// changes its surface is swept as the surface it now draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chrome {
	Footer,
	Header,
}

impl Chrome {
	/// The words drawn when the surface has a way back to the one above it.
	const fn back(self) -> &'static str {
		match self {
			Self::Footer => "Esc Back",
			Self::Header => "Back",
		}
	}

	/// The words drawn when leaving the surface closes it.
	const fn close(self) -> &'static str {
		match self {
			Self::Footer => "Esc Close",
			Self::Header => "Close",
		}
	}
}

fn chrome_of(session: &mut HeadlessSession<ShellView>) -> Chrome {
	session
		.update(|view, _window, _cx| match view.state().overlay.as_ref() {
			Some(Overlay::Palette(_)) => Chrome::Footer,
			_ => Chrome::Header,
		})
		.expect("the overlay kind is readable")
}

/// True when the frame drew exactly those words. The frame records the string
/// each run shaped, so the assertion reads what the surface said rather than a
/// width another run in the same frame can hold.
fn drew_text(captured: &Captured, text: &str) -> bool {
	captured
		.text_runs
		.iter()
		.any(|run| run.text.as_str() == text)
}

#[test]
fn a_surface_reached_directly_offers_no_way_back_to_one_never_opened() {
	for route in routes() {
		if route == SurfaceRoute::Commands {
			continue;
		}
		let case = route.title();
		let direct = render_session(fixture::populated(), |session| {
			let captured = walk(session, &[route]);
			let chrome = chrome_of(session);
			assert!(
				drew_text(&captured, chrome.close()),
				"{case}: a surface with nothing above it states that leaving closes it"
			);
			assert!(
				!drew_text(&captured, chrome.back()),
				"{case}: a surface entered directly offers no way back to one never opened"
			);
			captured.hitboxes.len()
		});
		let descended = render_session(fixture::populated(), |session| {
			let captured = walk(session, &[SurfaceRoute::Commands, route]);
			let chrome = chrome_of(session);
			assert!(
				drew_text(&captured, chrome.back()),
				"{case}: a descended surface states the way back it has"
			);
			assert_eq!(
				drew_text(&captured, chrome.close()),
				chrome == Chrome::Header,
				"{case}: the footer hint is spent on the way back, the header keeps its close"
			);
			captured.hitboxes.len()
		});
		assert_eq!(
			descended,
			direct + 1,
			"{case}: the descended surface draws one more control -- the way back -- than the same \
			 surface opened directly (direct {direct}, descended {descended})"
		);
	}
}

#[test]
fn history_preview_has_no_route_and_escape_closes_without_resuming_a_session() {
	for from_commands in [false, true] {
		render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					view.set_composed("retained draft", cx);
					if from_commands {
						view.open_command_palette(window, cx);
						view
							.state_mut()
							.overlay
							.as_mut()
							.and_then(Overlay::as_palette_mut)
							.expect("commands open")
							.set_query("/history");
						view.run_palette(cx);
						assert_eq!(view.drain_intents(), vec![
							veyyon_desktop_surface::Intent::FindSessions(String::new())
						]);
					}
					view.state_mut().overlay = Some(Overlay::History(Box::new(
						veyyon_desktop_surface::history::HistoryState::loading(
							"sessions/history.jsonl".into(),
						),
					)));
					assert_eq!(view.state().overlay.as_ref().and_then(Overlay::route), None);
					assert_eq!(
						view.back_route(),
						None,
						"a preview does not inherit a routed back target"
					);
					view.drain_intents();
					cx.notify();
				})
				.expect("history preview opens");
			session.frame().expect("history preview frame");
			assert_eq!(shown(session), Shown::History);
			session
				.keystroke("escape")
				.expect("Escape reaches the preview");
			session.frame().expect("closed preview frame");
			assert_eq!(shown(session), Shown::Nothing);
			session
				.update(|view, _, _| {
					assert_eq!(view.composer_text(), "retained draft");
					assert!(
						view.drain_intents().is_empty(),
						"closing a preview cannot resume a session"
					);
				})
				.expect("preview close outcome");
		});
	}
}

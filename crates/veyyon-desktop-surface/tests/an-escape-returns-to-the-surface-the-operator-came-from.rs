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
//! The chrome is measured in the same frames: a directly opened surface
//! registers exactly one hit rect fewer than the same surface descended into,
//! which is the `Back` control that must not be offered.
//!
//! WHAT IT DOES NOT CATCH: the browsed-directory ascent inside
//! `PaletteMode::Browse`, which `a-browse-row-lists-the-directory-it-opened`
//! owns; which focus the composer regains once the last surface closes, owned
//! by `a-row-that-opens-a-lookup-hands-it-the-keyboard`; and the X11 recorder's
//! own key delivery, which no in-process suite reaches.

use std::path::Path;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_desktop_kit::{ColorRole, TextRamp, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Keymap, SettingsPage, ShellState, ShellView, fixture, install_tokens, navigation::SurfaceRoute,
};
use veyyon_gpui::{
	App, AppContext, Font, FontFeatures, FontStyle, FontWeight, SharedString, TextRun,
};

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
	let mut routes = vec![SurfaceRoute::Commands, SurfaceRoute::Account, SurfaceRoute::Settings];
	routes.extend(SettingsPage::iter().map(SurfaceRoute::Page));
	for route in &routes {
		match route {
			SurfaceRoute::Commands
			| SurfaceRoute::Account
			| SurfaceRoute::Settings
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
}

fn shown(session: &mut HeadlessSession<ShellView>) -> Shown {
	session
		.update(|view, _window, _cx| match view.state().overlay.as_ref() {
			Some(overlay) => Shown::Surface(overlay.route()),
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

/// A focused page draws the settings surface, which carries no palette footer
/// and promises nothing about Escape; a group's palette carries one.
const fn draws_a_palette_footer(route: SurfaceRoute) -> bool {
	!matches!(route, SurfaceRoute::Page(_))
}

/// The width of `text` as the window's own text system shapes it at the size
/// the palette footer draws its hints in, so the assertion holds on whatever
/// face this machine resolved the authored chain to.
fn hint_width(session: &mut HeadlessSession<ShellView>, text: &'static str) -> f32 {
	session
		.update(|view, window, _cx| {
			let tokens = &view.installed().set;
			let run = TextRun {
				len:              text.len(),
				font:             Font {
					family:    tokens.ui_family(),
					features:  FontFeatures::default(),
					fallbacks: None,
					weight:    FontWeight::default(),
					style:     FontStyle::default(),
				},
				color:            tokens.color(ColorRole::Muted),
				background_color: None,
				underline:        None,
				strikethrough:    None,
			};
			let size = tokens.font_size(TextRamp::Micro);
			let shaped = window
				.text_system()
				.shape_line(SharedString::from(text), size, &[run], None);
			f32::from(shaped.width)
		})
		.expect("the hint shapes in the window's text system")
}

/// True when the frame drew a run of that width, which is the hint the footer
/// is promising.
fn drew_run_of_width(captured: &Captured, width: f32) -> bool {
	captured
		.text_runs
		.iter()
		.any(|run| (f32::from(run.bounds.size.width) - width).abs() < 0.5)
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
			if draws_a_palette_footer(route) {
				let close = hint_width(session, "Esc Close");
				assert!(
					drew_run_of_width(&captured, close),
					"{case}: the footer of a surface with nothing above it promises to close"
				);
			}
			captured.hitboxes.len()
		});
		let descended = render_session(fixture::populated(), |session| {
			let captured = walk(session, &[SurfaceRoute::Commands, route]);
			if draws_a_palette_footer(route) {
				let back = hint_width(session, "Esc Back");
				assert!(
					drew_run_of_width(&captured, back),
					"{case}: the footer of a descended surface promises the way back it has"
				);
			}
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

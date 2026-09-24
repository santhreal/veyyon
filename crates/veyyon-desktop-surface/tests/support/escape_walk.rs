//! Walking the surface hierarchy: the window the walk runs in, the routes it
//! reaches, and the ways one surface is arrived at.
//!
//! A surface is reached directly, twice over, from the command palette or
//! down every group between the two, and what an escape returns to depends on
//! which of those the walk performed. The harness lives here so the suites
//! that assert on the return read as the assertions they are.

use std::path::Path;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Keymap, Overlay, SettingsPage, ShellState, ShellView, install_tokens, navigation::SurfaceRoute,
};
use veyyon_gpui::{App, AppContext};

pub fn render_session<R>(
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
/// `SettingsPage` at run time, and the match is exhaustive, so a kind of route
/// added to the enum states how it is reached before this compiles.
pub fn routes() -> Vec<SurfaceRoute> {
	let mut routes = vec![
		SurfaceRoute::Commands,
		SurfaceRoute::Account,
		SurfaceRoute::Settings,
		SurfaceRoute::Agents,
		SurfaceRoute::Share,
		SurfaceRoute::Autoswarm,
	];
	routes.extend(SettingsPage::iter().map(SurfaceRoute::Page));
	for route in &routes {
		match route {
			SurfaceRoute::Commands
			| SurfaceRoute::Account
			| SurfaceRoute::Settings
			| SurfaceRoute::Agents
			| SurfaceRoute::Share
			| SurfaceRoute::Autoswarm
			| SurfaceRoute::Page(_) => {},
		}
	}
	routes
}

/// The four ways a surface is reached, which differ only in what the operator
/// walked through to get there.
#[derive(Debug, Clone, Copy, EnumIter)]
pub enum Way {
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
pub fn path(way: Way, route: SurfaceRoute) -> Option<Vec<SurfaceRoute>> {
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
pub fn ladder(walked: &[SurfaceRoute]) -> Vec<SurfaceRoute> {
	let mut rungs: Vec<SurfaceRoute> = Vec::with_capacity(walked.len());
	for route in walked.iter().copied() {
		if rungs.last() != Some(&route) {
			rungs.push(route);
		}
	}
	rungs
}

/// Walks a path and returns the frame the last surface drew.
pub fn walk(session: &mut HeadlessSession<ShellView>, walked: &[SurfaceRoute]) -> Captured {
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
pub enum Shown {
	Nothing,
	Surface(Option<SurfaceRoute>),
	History,
}

pub fn shown(session: &mut HeadlessSession<ShellView>) -> Shown {
	session
		.update(|view, _window, _cx| match view.state().overlay.as_ref() {
			Some(
				overlay @ (Overlay::Palette(_)
				| Overlay::Settings(_)
				| Overlay::Agents(_)
				| Overlay::Share(_)
				| Overlay::Autoswarm(_)),
			) => Shown::Surface(overlay.route()),
			Some(Overlay::History(_)) => Shown::History,
			None => Shown::Nothing,
		})
		.expect("the overlay is readable")
}

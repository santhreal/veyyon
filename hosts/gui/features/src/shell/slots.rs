//! Route policy and composable surface entry points.

use gpui::{App, Entity, IntoElement, ScrollHandle, Window};
use veyyon_gui_core::{
	Store,
	navigation::{BottomTab, Route},
};
use veyyon_gui_kit::input::Editor;

use super::{FrameSlots, toolbar};
use crate::{
	agents,
	changes::{self, ChangesCache, DiffViewport},
	composer, conversation,
	files::{self, FilesHandles},
	inspector,
	problems::{self, OutputRendererAdapter},
	settings,
	terminal::{self, RendererAdapter},
	transcript::{self, Timeline},
};

pub struct SurfaceRefs<'a> {
	pub session_shelf:       &'a conversation::SessionShelfState,
	pub session_search:      &'a Entity<Editor>,
	pub timeline:            &'a Entity<Timeline>,
	pub composer:            &'a Entity<Editor>,
	pub changes:             &'a ChangesCache,
	pub changes_search:      &'a Entity<Editor>,
	pub changes_scroll:      &'a ScrollHandle,
	pub diff:                &'a Entity<DiffViewport>,
	pub files:               &'a mut FilesHandles,
	pub agents_search:       &'a Entity<Editor>,
	pub agents_scroll:       &'a ScrollHandle,
	pub agent_detail_scroll: &'a ScrollHandle,
	pub settings_search:     &'a settings::SettingsSearch<'a>,
	pub settings_scroll:     &'a ScrollHandle,
	pub inspector_scroll:    &'a ScrollHandle,
	pub problems_search:     &'a Entity<Editor>,
	pub bottom_scroll:       &'a ScrollHandle,
	pub terminal:            Option<&'a mut (dyn RendererAdapter + 'static)>,
	pub output:              Option<&'a mut (dyn OutputRendererAdapter + 'static)>,
}

pub fn compose(
	store: &Store,
	handles: SurfaceRefs<'_>,
	window: &mut Window,
	cx: &mut App,
) -> FrameSlots {
	let SurfaceRefs {
		session_shelf,
		session_search,
		timeline,
		composer,
		changes,
		changes_search,
		changes_scroll,
		diff,
		files,
		agents_search,
		agents_scroll,
		agent_detail_scroll,
		settings_search,
		settings_scroll,
		inspector_scroll,
		problems_search,
		bottom_scroll,
		terminal,
		output,
	} = handles;
	let (sidebar, route_toolbar, workspace) = match store.frontend.route {
		Route::Conversation => (
			conversation::session_shelf(store, session_shelf, session_search, window, cx)
				.into_any_element(),
			conversation::route_toolbar(store, cx).into_any_element(),
			conversation::work_surface(
				transcript::render(store, timeline, cx),
				composer::render(store, composer, window, cx),
				gpui::Empty,
			)
			.into_any_element(),
		),
		Route::Changes => (
			changes::render_sidebar(store, changes, changes_search, changes_scroll, cx),
			changes::render_toolbar(store, cx),
			changes::render_center(store, diff, cx),
		),
		Route::Files => (
			files::render_sidebar(store, files, cx).into_any_element(),
			toolbar::route(store, Route::Files, cx),
			files::render_route(store, files, cx).into_any_element(),
		),
		Route::Agents => (
			agents::tree::render(store, agents_search, agents_scroll, cx).into_any_element(),
			toolbar::route(store, Route::Agents, cx),
			agents::render(store, agent_detail_scroll, cx).into_any_element(),
		),
		Route::Settings(page) => (
			settings::navigation(page, settings_search.settings, cx).into_any_element(),
			settings::route_toolbar(store, page, cx).into_any_element(),
			settings::center(store, page, settings_search, settings_scroll, cx).into_any_element(),
		),
	};
	let inspector = inspector::render_content(store, inspector_scroll, cx).into_any_element();
	let bottom = match store.frontend.bottom_tab {
		BottomTab::Terminals => terminal::render(store, terminal, cx),
		BottomTab::Problems => problems::render_problems(store, problems_search, bottom_scroll, cx),
		BottomTab::Output => problems::render_output(store, output, cx),
	};
	FrameSlots {
		sidebar_header: gpui::Empty.into_any_element(),
		sidebar,
		route_toolbar,
		workspace,
		inspector,
		bottom,
	}
}

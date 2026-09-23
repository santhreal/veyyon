//! What an intent changes in the overlay the window is drawing (§5.8, §5.9).
//!
//! A route opens the sheet it names, and a route inside a sheet already open
//! keeps what that sheet holds: settings reached from the palette would
//! otherwise redraw as an empty page while the host re-states its domains.

use crate::{
	agents::AgentViewTab, model::ShellState, navigation::SurfaceRoute, overlay::Overlay,
	palette::PaletteMode,
};

/// Opens the surface a route names, carrying what the open sheet holds.
pub fn navigate(state: &mut ShellState, route: SurfaceRoute) {
	let mut destination = route.overlay();
	if let (Some(Overlay::Settings(current)), Overlay::Settings(next)) =
		(&state.overlay, &mut destination)
	{
		let page = next.page;
		next.clone_from(current);
		next.page = page;
		next.route = Some(route);
	}
	if let Overlay::Agents(agents) = &mut destination {
		agents.route = Some(route);
	}
	if let Overlay::Share(share) = &mut destination {
		share.route = Some(route);
	}
	// The command surface reached by a route lists what the host stated too,
	// on the same terms as the one a keystroke opens.
	if let Overlay::Palette(palette) = &mut destination
		&& route == SurfaceRoute::Commands
	{
		state.list_host_commands(palette);
	}
	state.overlay = Some(destination);
}

/// Ranks the rows the palette holds, narrowing the rail with the same query
/// while the rail's own session search is the mode in hand.
pub fn palette_query(state: &mut ShellState, query: &str) {
	let narrows_rail = if let Some(Overlay::Palette(palette)) = &mut state.overlay {
		palette.set_query(query.to_string());
		// The rail's own session search narrows the rail as it is typed, which
		// is what filtering the queue in place means and what the header's
		// filter chip and its clear control act on. A history search ranks the
		// persisted sessions the host holds and leaves the rail as it is.
		palette.mode == PaletteMode::Sessions && !palette.is_history()
	} else {
		false
	};
	if narrows_rail {
		super::queue::filter(state, query);
	}
}

/// Moves the palette's selection by `delta` rows.
pub fn palette_move(state: &mut ShellState, delta: i32) {
	if let Some(Overlay::Palette(palette)) = &mut state.overlay {
		palette.move_selection(delta);
	}
}

/// Opens Browse mode on one directory, since the row that asked for a listing
/// is run from another mode's list and closes it.
pub fn browse_to(state: &mut ShellState, path: Option<&String>) {
	state.palette_in(PaletteMode::Browse, |palette| palette.browse_to(path.cloned()));
}

/// Records what a lookup was asked for in `mode`.
///
/// A lookup's rows are the host's answer to one query, so emptying the field
/// drops them here rather than leaving them drawn until a frame arrives: an
/// empty query asks for no search, so no answer is on its way to replace them
/// (§5.8).
pub fn find_in(state: &mut ShellState, mode: PaletteMode, query: &str) {
	state.palette_in(mode, |palette| {
		palette.set_query(query.to_string());
		if query.is_empty() {
			palette.set_items(Vec::new());
		}
	});
}

/// Opens the persisted-session search on `query`.
pub fn find_sessions(state: &mut ShellState, query: &str) {
	state.overlay = Some(Overlay::Palette(crate::PaletteState::history(query.to_string())));
}

/// Opens one persisted session's preview, which loads until the host answers.
pub fn preview_session(state: &mut ShellState, session: &str) {
	state.overlay =
		Some(Overlay::History(Box::new(crate::history::HistoryState::loading(session.to_string()))));
}

/// Moves the agent dashboard to the view the operator chose.
pub fn agents_tab(state: &mut ShellState, tab: AgentViewTab) {
	if let Some(Overlay::Agents(agents)) = &mut state.overlay {
		agents.active_tab = tab;
	}
}

/// Records which agent the dashboard is asking to end, or that it asks for
/// none.
pub fn confirm_termination(state: &mut ShellState, id: Option<&String>) {
	if let Some(Overlay::Agents(agents)) = &mut state.overlay {
		agents.pending_termination = id.cloned();
	}
}

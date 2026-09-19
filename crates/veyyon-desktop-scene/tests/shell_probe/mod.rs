//! Probe seeding the shell states that draw the breakpoint and shell token
//! groups.

use std::path::Path;

use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{Headless, RenderOptions, headless::render_view};
use veyyon_desktop_surface::{Availability, ConnectionPhase, ShellView, fixture, install_tokens};
use veyyon_desktop_tokens::{Tokens, load_bundled_theme};
use veyyon_gpui::AppContext;

use crate::dead_token_probe::{Observation, frame_observation, shell};

struct ProbeSpec {
	name:        &'static str,
	options:     RenderOptions,
	state:       veyyon_desktop_surface::model::ShellState,
	open_rename: bool,
	open_float:  bool,
}

/// Renders every shell state that draws a measure of `surface.breakpoints`
/// or `surface.shell`.
pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let mut wide_state = fixture::populated();
	wide_state.drawer_open = true;
	wide_state.drawer.offered = true;
	wide_state.keymap.panel_collapsed = false;
	wide_state.connection = ConnectionPhase::Attached;
	wide_state.keymap.queue_collapsed = false;
	wide_state
		.controls
		.set_availability(SurfaceId::NewSessionButton, Availability::Pending);
	wide_state.controls.set_availability(
		SurfaceId::QueueParkButton(SessionId("1".into())),
		Availability::Unavailable { reason: "test".into() },
	);

	let mut standard_state = fixture::populated();
	standard_state.drawer_open = true;
	standard_state.drawer.offered = true;
	standard_state.keymap.panel_collapsed = false;
	standard_state.connection = ConnectionPhase::Attached;
	standard_state.keymap.queue_collapsed = false;

	let mut compact_state = fixture::populated();
	compact_state.drawer_open = true;
	compact_state.drawer.offered = true;
	compact_state.connection = ConnectionPhase::Attached;

	let mut collapsed_state = fixture::populated();
	collapsed_state.drawer_open = true;
	collapsed_state.drawer.offered = true;
	collapsed_state.connection = ConnectionPhase::Attached;

	let mut rename_state = fixture::populated();
	let current_id = rename_state.current_id;
	rename_state.controls.set_availability(
		SurfaceId::SessionRenameField(SessionId(current_id.to_string())),
		Availability::Enabled,
	);
	rename_state.connection = ConnectionPhase::Attached;

	let specs = vec![
		ProbeSpec {
			name:        "shell_wide",
			options:     shell::wide(),
			state:       wide_state,
			open_rename: false,
			open_float:  false,
		},
		ProbeSpec {
			name:        "shell_standard",
			options:     shell::sized(1280, 900),
			state:       standard_state,
			open_rename: false,
			open_float:  false,
		},
		ProbeSpec {
			name:        "shell_compact",
			options:     shell::sized(1050, 800),
			state:       compact_state,
			open_rename: false,
			open_float:  false,
		},
		ProbeSpec {
			name:        "shell_collapsed",
			options:     shell::sized(850, 700),
			state:       collapsed_state,
			open_rename: false,
			open_float:  true,
		},
		ProbeSpec {
			name:        "shell_rename",
			options:     shell::sized(1400, 900),
			state:       rename_state,
			open_rename: true,
			open_float:  false,
		},
	];

	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	specs
		.into_iter()
		.map(|spec| {
			let tokens = tokens.clone();
			let theme = theme.clone();
			let frame = render_view(cx, &spec.options, move |window, app| {
				let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
					.expect("the bundled token set must install");
				app.new(|cx| {
					let mut view = ShellView::new(installed, spec.state);
					if spec.open_rename {
						view.open_session_rename(window, cx);
					}
					if spec.open_float {
						view.set_queue_float_open(true);
					}
					view
				})
			})
			.expect("the shell must render");
			frame_observation(spec.name, &frame)
		})
		.collect()
}

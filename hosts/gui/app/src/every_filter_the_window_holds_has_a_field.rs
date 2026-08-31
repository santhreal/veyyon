//! WHY THIS SUITE EXISTS. Seven filters in this window were state with no
//! surface. `agent_filter`, `settings_filter`, `problem_filter`, `model_query`,
//! `provider_query`, `mcp_query` and `extension_query` each had a command that
//! wrote them, a store field that held them, and a list that narrowed itself by
//! them — and no field anywhere that a reader could type into. The rosters were
//! walked by scrolling while the filter behind each one was unreachable, and
//! the filtering code under it never ran.
//!
//! THE CLASS. A filter reaches a list through three parts: a drawn field, a
//! command the field raises, and a reader that narrows by the value. A missing
//! middle or end is a compile error. A missing field compiles, keeps its tests
//! green and ships a control nobody can reach, so the field is what is asserted
//! here, and it is asserted the way a reader reaches it: the keyboard is put on
//! the editor the surface was handed, text is typed as the platform delivers
//! it, and the store is read back. An editor no element drew registers no input
//! handler, so the typing lands nowhere and the value stays empty — which is
//! exactly how each of the seven behaved before its field existed.
//!
//! The variant space comes from `FrontendState` at run time rather than from a
//! list written here, so a filter field added to the store fails this suite
//! until it is either covered by a row or recorded as an exception.
//!
//! WHAT IT DOES NOT CATCH. `terminal_search`, which is a map keyed by terminal
//! rather than one query, and is not part of the derived set. The terminal
//! surface owns it.
//!
//! Whether the field is where a reader would look for it, or reachable by
//! pointer. This puts the keyboard on the editor directly, so a field drawn off
//! screen or under another element would pass. The capture scenes own
//! placement.

use std::collections::BTreeSet;

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_gui_core::{
	UiCommand,
	host::{HostEvent, SnapshotSection},
	model::{
		AuthState, CommandState, DiagnosticLevel, DiagnosticView, DiagnosticsSnapshot,
		ExtensionRegistryState, McpState, ModelCatalogState, NoticeId, RemoteData, ThinkingSelection,
		Versioned,
	},
	navigation::{BottomTab, FrontendState, Route, SettingsPage},
};
use veyyon_gui_kit::input::Editor;

use crate::{
	handles::Editors,
	shell::Shell,
	the_keyboard_reaches_every_route::{attached, open_with},
};

/// How the window reaches the surface a field is drawn on.
enum Surface {
	Route(Route),
	/// The bottom dock, which starts closed: a tab is only drawn once it is
	/// both selected and open.
	Dock(BottomTab),
}

struct Row {
	/// The `FrontendState` field the filter is held in, named as it serializes.
	state:   &'static str,
	surface: Surface,
	field:   fn(&Editors) -> &Entity<Editor>,
}

/// Every filter the window draws a field for, with the surface that draws it.
fn rows() -> Vec<Row> {
	vec![
		Row {
			state:   "session_filter",
			surface: Surface::Route(Route::Conversation),
			field:   |editors| &editors.sessions,
		},
		Row {
			state:   "changes_filter",
			surface: Surface::Route(Route::Changes),
			field:   |editors| &editors.changes_search,
		},
		Row {
			state:   "file_filter",
			surface: Surface::Route(Route::Files),
			field:   |editors| &editors.files,
		},
		Row {
			state:   "agent_filter",
			surface: Surface::Route(Route::Agents),
			field:   |editors| &editors.agents,
		},
		Row {
			state:   "settings_filter",
			surface: Surface::Route(Route::Settings(SettingsPage::General)),
			field:   |editors| &editors.settings,
		},
		Row {
			state:   "model_query",
			surface: Surface::Route(Route::Settings(SettingsPage::Models)),
			field:   |editors| &editors.models,
		},
		Row {
			state:   "provider_query",
			surface: Surface::Route(Route::Settings(SettingsPage::Providers)),
			field:   |editors| &editors.providers,
		},
		Row {
			state:   "mcp_query",
			surface: Surface::Route(Route::Settings(SettingsPage::Mcp)),
			field:   |editors| &editors.mcp,
		},
		Row {
			state:   "extension_query",
			surface: Surface::Route(Route::Settings(SettingsPage::Tools)),
			field:   |editors| &editors.extensions,
		},
		Row {
			state:   "problem_filter",
			surface: Surface::Dock(BottomTab::Problems),
			field:   |editors| &editors.problems,
		},
	]
}

/// A filter the window holds on purpose without drawing a route field for it.
/// Pinned by exact equality: a new uncovered filter belongs in `rows()` or
/// beside this reason, and either way somebody decides rather than nobody
/// noticing.
const WITHOUT_A_ROUTE_FIELD: [&str; 1] = [
	// The palette's own query. Its field is the sheet, which no route draws,
	// and `a_reopened_palette_starts_on_an_empty_field` owns it.
	"palette_query",
];

/// Every filter the store holds, read from the state itself so a filter added
/// later is swept without this file being edited.
fn filters_the_store_holds() -> BTreeSet<String> {
	let state = serde_json::to_value(FrontendState::default())
		.expect("the frontend state serializes; it is persisted");
	let object = state.as_object().expect("the frontend state is a struct");
	object
		.iter()
		.filter(|(key, value)| {
			value.is_string() && (key.ends_with("_filter") || key.ends_with("_query"))
		})
		.map(|(key, _)| key.clone())
		.collect()
}

/// What a host has published once its catalogues have arrived. Four settings
/// pages draw their filter only over a ready replica, which is correct — an
/// empty page has nothing to narrow — so the replica has to arrive before the
/// field can be typed into.
fn with_catalogues() -> Vec<HostEvent> {
	let mut events = attached();
	events.extend([
		HostEvent::Snapshot(SnapshotSection::Models(Versioned {
			revision: 1,
			value:    ModelCatalogState {
				models:   RemoteData::Empty,
				selected: None,
				thinking: ThinkingSelection {
					configured:        None,
					effective:         None,
					supported_efforts: Vec::new(),
					default:           None,
				},
				refresh:  CommandState::Idle,
			},
		})),
		HostEvent::Snapshot(SnapshotSection::Authentication(Versioned {
			revision: 1,
			value:    AuthState {
				providers:     RemoteData::Empty,
				accounts:      RemoteData::Empty,
				flow_provider: None,
				flow:          None,
			},
		})),
		HostEvent::Snapshot(SnapshotSection::Mcp(Versioned {
			revision: 1,
			value:    McpState { servers: RemoteData::Empty, startup: Vec::new() },
		})),
		HostEvent::Snapshot(SnapshotSection::Extensions(Versioned {
			revision: 1,
			value:    ExtensionRegistryState {
				extensions:             Vec::new(),
				plugins:                Vec::new(),
				commands:               Vec::new(),
				skills:                 Vec::new(),
				tools:                  Vec::new(),
				load_failures:          Vec::new(),
				provider_contributions: Vec::new(),
			},
		})),
		HostEvent::Snapshot(SnapshotSection::Diagnostics(Versioned {
			revision: 1,
			value:    DiagnosticsSnapshot {
				// One finding, because a dock with nothing in it draws the
				// healthy state instead of the toolbar the filter sits in.
				notices:                vec![DiagnosticView {
					id:             NoticeId::new("notice-1").expect("a non-empty id"),
					source:         "test".to_owned(),
					level:          DiagnosticLevel::Error,
					message:        "a finding to filter".to_owned(),
					path:           None,
					line:           None,
					column:         None,
					occurred_at_ms: 0,
				}],
				files:                  Vec::new(),
				source_errors:          Vec::new(),
				startup_health:         Vec::new(),
				session_resume_warning: None,
			},
		})),
	]);
	events
}

fn reach(shell: &Entity<Shell>, surface: &Surface, cx: &mut VisualTestContext) {
	// Selecting a dock tab opens the dock, so nothing here toggles it: a toggle
	// after the selection closes what the selection opened.
	let command = match surface {
		Surface::Route(route) => UiCommand::Navigate(*route),
		Surface::Dock(tab) => UiCommand::SetBottomTab(*tab),
	};
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| shell.perform(command, window, cx));
	});
	// The surface has to be on screen before the keyboard is put in it: a
	// keystroke dispatches from the focused element, and an element the last
	// frame did not draw is not in the tree to dispatch from.
	cx.run_until_parked();
}

/// Put the keyboard on the editor the surface was handed, the way a click on
/// the field does.
fn take_the_field(shell: &Entity<Shell>, row: &Row, cx: &mut VisualTestContext) {
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			let field = (row.field)(&shell.handles.editors).clone();
			Editor::focus(&field, window, cx);
		});
	});
}

fn filter_value(shell: &Entity<Shell>, state: &str, cx: &mut VisualTestContext) -> String {
	let frontend = shell.read_with(cx, |shell, _| shell.store.frontend.clone());
	let value = serde_json::to_value(frontend).expect("the frontend state serializes");
	value
		.get(state)
		.and_then(serde_json::Value::as_str)
		.map(str::to_owned)
		.unwrap_or_else(|| panic!("{state} is not a string field of the frontend state"))
}

#[gpui::test]
fn typing_in_a_surfaces_filter_field_narrows_that_surface(cx: &mut TestAppContext) {
	let (shell, cx) = open_with(cx, with_catalogues());
	// A panel's drawn height is its animated one, and the dock opens from
	// nothing: the reader's own reduced-motion setting is what puts a panel at
	// its target on the frame it opens, so the sweep is not racing a spring.
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(UiCommand::SetReducedMotion(true), window, cx);
		});
	});
	cx.run_until_parked();

	for row in rows() {
		reach(&shell, &row.surface, cx);
		take_the_field(&shell, &row, cx);

		cx.simulate_input("narrow");

		assert_eq!(
			filter_value(&shell, row.state, cx),
			"narrow",
			"{} took no typing: the surface draws no field for it",
			row.state
		);

		// And the reader can empty it again, which is the only way back to the
		// unfiltered list once a field owns the value.
		cx.simulate_keystrokes("backspace backspace backspace backspace backspace backspace");
		assert_eq!(
			filter_value(&shell, row.state, cx),
			"",
			"{} could be typed into but not cleared",
			row.state
		);
	}
}

#[gpui::test]
fn every_filter_the_store_holds_is_covered_or_recorded(cx: &mut TestAppContext) {
	let _ = cx;
	let covered: BTreeSet<String> = rows().into_iter().map(|row| row.state.to_owned()).collect();
	let uncovered: Vec<String> = filters_the_store_holds()
		.difference(&covered)
		.cloned()
		.collect();

	assert_eq!(
		uncovered, WITHOUT_A_ROUTE_FIELD,
		"a filter the store holds is drawn by no surface and recorded as no exception"
	);
}

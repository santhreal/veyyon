//! WHY THIS SUITE EXISTS.
//!
//! The app is usable with no engine attached, which means every interaction is
//! a move over the store rather than a socket call. That is only true if the
//! moves actually move: the defect this suite exists to prevent is a window
//! that draws a session list nobody can select from, a composer that takes
//! characters and sends nothing, and a panel that reports a command it never
//! ran. All of that is invisible in a screenshot and invisible to a type check.
//!
//! Each test drives the real move against the real seed store, in the order the
//! window calls them.
//!
//! WHAT IT DOES NOT CATCH. Anything about drawing: layout, colour, hit testing,
//! focus, or whether the element that calls a move is reachable with a pointer.
//! A move proved here and wired to nothing passes. The window's own smoke run
//! covers that.

use super::{
	agent,
	model::{
		Activity, Appearance, Block, PaletteKind, ProjectId, Role, Route, SESSION_TITLE_UNTITLED,
		SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SessionId, SettingsPage, Store, TERMINAL_MIN,
	},
	moves, seed,
};

fn store() -> Store {
	seed::store()
}

fn id(key: &str) -> SessionId {
	SessionId::new(key)
}

/// Type into the selected session and send, the way the composer does.
fn type_and_send(store: &mut Store, text: &str) -> bool {
	moves::set_draft(store, text.to_owned(), text.len());
	moves::send(store)
}

/// Run the clock until nothing in the store moves, and return the time it took.
///
/// The opening store has a reply in flight, so a test about a still window has
/// to reach stillness first. The bound is the assertion: a reveal that never
/// finishes would otherwise show up as a hung suite rather than a failure.
fn settle(store: &mut Store) -> u64 {
	let mut clock = 0;
	while clock < 60_000 {
		clock += 16;
		if !moves::tick(store, clock) && !store.animating() {
			return clock;
		}
	}
	panic!("the store never settled");
}

#[test]
fn the_seed_carries_one_session_of_every_activity() {
	let store = store();
	let mut present: Vec<Activity> = store
		.sessions
		.iter()
		.map(|session| session.status)
		.collect();
	present.sort_by_key(|activity| activity.rank());
	present.dedup();
	assert_eq!(
		present,
		Activity::ALL.to_vec(),
		"an activity the sidebar orders by has no session in the opening store, so its row shape is \
		 unreachable without typing"
	);
}

#[test]
fn a_row_is_ordered_by_what_it_wants_before_when_it_moved() {
	let mut store = store();
	// Everything that is moving is newer than the session that stopped for an
	// answer, which is the case time-ordering gets wrong.
	for session in &mut store.sessions {
		if session.status != Activity::Waiting {
			session.updated_ms = 10_000;
		}
	}
	let rows = store.rows(&ProjectId::new("veyyon"));
	let states: Vec<Activity> = rows.iter().map(|session| session.status).collect();
	assert_eq!(states, vec![Activity::Waiting, Activity::Failed, Activity::Working, Activity::Idle]);
}

#[test]
fn inside_one_activity_the_newest_row_is_first() {
	let mut store = store();
	let project = ProjectId::new("veyyon");
	let older = id("themes");
	let newer = id("second-idle");
	let mut extra = super::model::Session::new(newer.as_str(), &project, "Later idle work");
	extra.status = Activity::Idle;
	extra.updated_ms = 9_000;
	store.sessions.push(extra);
	store.session_mut(&older).expect("seeded").updated_ms = 1_000;

	let idle: Vec<SessionId> = store
		.rows(&project)
		.iter()
		.filter(|session| session.status == Activity::Idle)
		.map(|session| session.id.clone())
		.collect();
	assert_eq!(idle, vec![newer, older]);
}

#[test]
fn selecting_a_row_reads_it() {
	let mut store = store();
	let waiting = id("modifier");
	assert!(store.session(&waiting).expect("seeded").unread);

	moves::select(&mut store, &waiting);

	assert_eq!(store.selected, Some(waiting.clone()));
	assert!(!store.session(&waiting).expect("seeded").unread);
	assert_eq!(store.route, Route::Chat);
}

#[test]
fn selecting_a_finished_session_settles_it() {
	let mut store = store();
	let done = id("og");
	assert_eq!(store.session(&done).expect("seeded").status, Activity::Done);

	moves::select(&mut store, &done);

	assert_eq!(
		store.session(&done).expect("seeded").status,
		Activity::Idle,
		"a session that was read still reports itself as finished-and-unread"
	);
}

#[test]
fn selecting_a_session_that_is_not_there_leaves_the_selection_alone() {
	let mut store = store();
	let before = store.selected.clone();
	moves::select(&mut store, &id("nothing"));
	assert_eq!(store.selected, before);
}

#[test]
fn cycling_walks_the_order_the_sidebar_draws_and_wraps_at_both_ends() {
	let mut store = store();
	let order = store.visible_order();
	assert!(order.len() > 2);

	moves::select(&mut store, &order[0]);
	moves::cycle(&mut store, true);
	assert_eq!(store.selected.as_ref(), Some(&order[1]));

	moves::select(&mut store, &order[order.len() - 1]);
	moves::cycle(&mut store, true);
	assert_eq!(store.selected.as_ref(), Some(&order[0]), "forward off the end did not wrap");

	moves::select(&mut store, &order[0]);
	moves::cycle(&mut store, false);
	assert_eq!(
		store.selected.as_ref(),
		Some(&order[order.len() - 1]),
		"backward off the start did not wrap"
	);
}

#[test]
fn cycling_with_nothing_selected_enters_the_list_rather_than_doing_nothing() {
	let mut store = store();
	let order = store.visible_order();
	store.selected = None;
	moves::cycle(&mut store, true);
	assert_eq!(store.selected.as_ref(), Some(&order[0]));

	store.selected = None;
	moves::cycle(&mut store, false);
	assert_eq!(store.selected.as_ref(), Some(&order[order.len() - 1]));
}

#[test]
fn a_folded_group_leaves_the_order_but_still_counts_what_it_hides() {
	let mut store = store();
	let project = ProjectId::new("veyyon");
	let waiting_before = store.waiting(&project);
	assert!(waiting_before > 0);

	moves::toggle_project(&mut store, &project);

	assert!(
		!store.visible_order().iter().any(|row| store
			.session(row)
			.is_some_and(|session| session.project == project)),
		"a folded group still offers its rows to keyboard traversal"
	);
	assert_eq!(
		store.waiting(&project),
		waiting_before,
		"folding a group hid the count of what needs an answer inside it"
	);
}

#[test]
fn the_open_session_stays_in_the_list_when_its_reply_lands() {
	// The window opens on a reply in flight. When it settles the row would
	// leave the list under the default filter, leaving a transcript on screen
	// with nothing selected in the sidebar.
	let mut store = store();
	let open = store.selected.clone().expect("the seed opens on a session");
	settle(&mut store);
	assert_eq!(
		store.selected_session().expect("selected").status,
		Activity::Done,
		"the opening reply never settled, so this proves nothing"
	);
	assert!(!store.settings.show_settled, "the filter under test is off by default");
	assert!(
		store.visible_order().contains(&open),
		"the session being read left the sidebar when it settled"
	);

	// Every other settled row still goes.
	moves::select(&mut store, &id("themes"));
	assert!(
		!store.visible_order().contains(&open),
		"a settled row nobody is reading stayed in the list"
	);
}

#[test]
fn settled_rows_are_out_of_the_list_until_asked_for() {
	let mut store = store();
	let done = id("og");
	assert!(!store.visible_order().contains(&done));

	store.settings.show_settled = true;

	assert!(store.visible_order().contains(&done));
}

#[test]
fn sending_appends_the_message_and_starts_a_reply() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	let before = store.selected_session().expect("selected").messages.len();

	assert!(type_and_send(&mut store, "read the theme loader"));

	let session = store.selected_session().expect("selected");
	assert_eq!(session.messages.len(), before + 2, "a send did not append a turn and a reply");
	assert_eq!(session.messages[before].role, Role::User);
	assert_eq!(session.messages[before + 1].role, Role::Assistant);
	assert_eq!(session.status, Activity::Working);
	assert!(session.run.is_some());
	assert!(session.draft.is_empty(), "the draft survived the send");
	assert_eq!(session.caret, 0);
}

#[test]
fn an_empty_draft_sends_nothing() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	let before = store.selected_session().expect("selected").messages.len();

	assert!(!type_and_send(&mut store, "   \n  "));

	assert_eq!(store.selected_session().expect("selected").messages.len(), before);
}

#[test]
fn a_second_send_while_a_reply_is_arriving_is_refused() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	assert!(type_and_send(&mut store, "first"));
	let after_first = store.selected_session().expect("selected").messages.len();

	assert!(!type_and_send(&mut store, "second"), "two replies were started at once");

	assert_eq!(store.selected_session().expect("selected").messages.len(), after_first);
}

#[test]
fn a_reply_arrives_a_piece_at_a_time_and_then_stops() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	type_and_send(&mut store, "read the theme loader");

	let mut clock = 0;
	let mut lengths = Vec::new();
	for _ in 0..4_000 {
		clock += 8;
		moves::tick(&mut store, clock);
		let session = store.selected_session().expect("selected");
		lengths.push(session.messages.last().expect("reply").text().len());
		if session.run.is_none() {
			break;
		}
	}

	let session = store.selected_session().expect("selected");
	assert!(session.run.is_none(), "the reply never finished, so the run does not terminate");
	assert_eq!(session.status, Activity::Done);
	assert!(session.unread, "a finished reply did not mark the row unread");
	let first = lengths.first().copied().unwrap_or_default();
	let last = lengths.last().copied().unwrap_or_default();
	assert!(last > first, "the reply landed whole instead of streaming");
	assert!(
		lengths.windows(2).all(|pair| pair[1] >= pair[0]),
		"the visible reply went backwards mid-stream"
	);
}

#[test]
fn a_reply_that_asks_a_question_leaves_the_row_waiting() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	type_and_send(&mut store, "which loader should it use?");
	let mut clock = 0;
	while store.selected_session().expect("selected").run.is_some() && clock < 60_000 {
		clock += 16;
		moves::tick(&mut store, clock);
	}
	assert_eq!(store.selected_session().expect("selected").status, Activity::Waiting);
}

#[test]
fn tick_reports_whether_anything_moved_so_a_still_window_stops_redrawing() {
	let mut store = store();
	let settled_at = settle(&mut store);
	assert!(!moves::tick(&mut store, settled_at + 1_000), "a settled store asked for another frame");

	moves::select(&mut store, &id("themes"));
	type_and_send(&mut store, "read it");
	assert!(moves::tick(&mut store, settled_at + 2_000), "a live reply did not ask for a frame");
}

#[test]
fn interrupting_keeps_what_already_arrived() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	type_and_send(&mut store, "read the theme loader");
	let mut clock = 0;
	for _ in 0..20 {
		clock += 16;
		moves::tick(&mut store, clock);
	}
	let partial = store
		.selected_session()
		.expect("selected")
		.messages
		.last()
		.expect("reply")
		.text();
	assert!(!partial.is_empty());

	moves::interrupt(&mut store);

	let session = store.selected_session().expect("selected");
	assert!(session.run.is_none());
	assert_eq!(session.status, Activity::Idle);
	assert_eq!(
		session.messages.last().expect("reply").text(),
		partial,
		"interrupting threw away the part of the reply that had arrived"
	);
}

#[test]
fn a_new_session_takes_its_title_from_the_first_thing_sent() {
	let mut store = store();
	let id = moves::new_session(&mut store);
	assert_eq!(store.session(&id).expect("new").title, SESSION_TITLE_UNTITLED);

	type_and_send(&mut store, "port the grep kernel to the compiled matcher");

	assert_eq!(
		store.session(&id).expect("new").title,
		agent::title_for("port the grep kernel to the compiled matcher")
	);
}

#[test]
fn a_new_session_opens_in_the_project_of_the_one_it_was_started_from() {
	let mut store = store();
	moves::select(&mut store, &id("install"));
	let from = store.selected_session().expect("selected").project.clone();

	let new = moves::new_session(&mut store);

	assert_eq!(store.session(&new).expect("new").project, from);
	assert_eq!(store.selected.as_ref(), Some(&new));
}

#[test]
fn archiving_the_selected_session_moves_the_selection_into_the_list() {
	let mut store = store();
	let selected = store.selected.clone().expect("the seed selects a session");

	moves::archive(&mut store, &selected);

	assert!(store.session(&selected).expect("archived").archived);
	assert!(!store.visible_order().contains(&selected));
	let now = store
		.selected
		.clone()
		.expect("selection was dropped rather than moved");
	assert_ne!(now, selected);
	assert!(store.visible_order().contains(&now));
}

#[test]
fn a_draft_belongs_to_its_session_and_survives_a_switch() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	moves::set_draft(&mut store, "half a thought".to_owned(), 5);

	moves::select(&mut store, &id("install"));
	assert_eq!(store.selected_session().expect("selected").draft, "");

	moves::select(&mut store, &id("themes"));
	let session = store.selected_session().expect("selected");
	assert_eq!(session.draft, "half a thought");
	assert_eq!(session.caret, 5);
}

#[test]
fn a_caret_past_the_end_of_the_draft_is_pulled_back_to_it() {
	let mut store = store();
	moves::set_draft(&mut store, "abc".to_owned(), 99);
	assert_eq!(store.selected_session().expect("selected").caret, 3);
}

#[test]
fn the_sidebar_width_is_clamped_at_both_ends_and_resets_to_the_default() {
	let mut store = store();
	moves::set_sidebar_width(&mut store, 40.0);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_MIN);

	moves::set_sidebar_width(&mut store, 9_000.0);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_MAX);

	moves::reset_sidebar_width(&mut store);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_DEFAULT);
}

#[test]
fn dragging_the_sidebar_while_it_is_closed_opens_it() {
	let mut store = store();
	store.settings.sidebar_open = false;
	moves::set_sidebar_width(&mut store, 300.0);
	assert!(store.settings.sidebar_open);
}

#[test]
fn toggling_the_sidebar_twice_returns_to_where_it_started() {
	let mut store = store();
	let before = store.settings.sidebar_open;
	moves::toggle_sidebar(&mut store);
	assert_ne!(store.settings.sidebar_open, before);
	moves::toggle_sidebar(&mut store);
	assert_eq!(store.settings.sidebar_open, before);
}

#[test]
fn running_a_command_opens_the_panel_and_streams_its_output() {
	let mut store = store();
	let tabs = store.terminal.tabs.len();

	moves::run_command(&mut store, "cargo check");

	assert!(store.terminal.open, "a command ran into a panel nobody can see");
	assert_eq!(store.terminal.tabs.len(), tabs + 1);
	assert_eq!(store.terminal.active, tabs);
	let tab = store.terminal.active_tab().expect("the new tab");
	assert!(tab.lines.is_empty(), "the whole output landed before a single frame");
	assert!(tab.is_running());

	let mut clock = store.now_ms;
	for _ in 0..200 {
		clock += 50;
		moves::tick(&mut store, clock);
		if store
			.terminal
			.active_tab()
			.expect("the new tab")
			.exit
			.is_some()
		{
			break;
		}
	}

	let tab = store.terminal.active_tab().expect("the new tab");
	assert_eq!(tab.exit, Some(0));
	assert!(!tab.lines.is_empty());
	assert!(tab.pending.is_empty());
}

#[test]
fn a_command_that_does_not_exist_exits_nonzero_in_its_tab() {
	let mut store = store();
	moves::run_command(&mut store, "gate.sh");
	let mut clock = store.now_ms;
	for _ in 0..200 {
		clock += 50;
		moves::tick(&mut store, clock);
		if store.terminal.active_tab().expect("tab").exit.is_some() {
			break;
		}
	}
	let tab = store.terminal.active_tab().expect("tab");
	assert!(tab.failed(), "a failed command reported success");
}

#[test]
fn the_panel_height_is_floored_and_bounded_by_the_viewport() {
	let mut store = store();
	moves::set_terminal_height(&mut store, 10.0, 800.0);
	assert_eq!(store.terminal.height, TERMINAL_MIN);

	moves::set_terminal_height(&mut store, 5_000.0, 400.0);
	assert_eq!(store.terminal.height, 400.0);
}

#[test]
fn closing_the_last_terminal_tab_closes_the_panel() {
	let mut store = store();
	store.terminal.open = true;
	while !store.terminal.tabs.is_empty() {
		moves::close_terminal_tab(&mut store, 0);
	}
	assert!(!store.terminal.open);
	assert_eq!(store.terminal.active, 0);
}

#[test]
fn closing_a_tab_leaves_the_selection_on_a_tab_that_exists() {
	let mut store = store();
	store.terminal.active = store.terminal.tabs.len() - 1;
	let last = store.terminal.active;
	moves::close_terminal_tab(&mut store, last);
	assert!(store.terminal.active < store.terminal.tabs.len());
	assert!(store.terminal.active_tab().is_some());
}

#[test]
fn the_palette_filters_what_it_offers_and_keeps_the_cursor_on_a_row() {
	let mut store = store();
	moves::open_palette(&mut store, PaletteKind::Command);
	let all = moves::palette_rows(&store).len();
	assert!(all > 1);

	moves::palette_query(&mut store, "grep".to_owned());
	let filtered = moves::palette_rows(&store);
	assert!(filtered.len() < all);
	assert!(!filtered.is_empty(), "a query that matches a session found nothing");

	moves::palette_move(&mut store, 50);
	let palette = store.overlay.palette().expect("open");
	assert_eq!(palette.selected, filtered.len() - 1, "the cursor ran off the end of the matches");

	moves::palette_move(&mut store, -50);
	assert_eq!(store.overlay.palette().expect("open").selected, 0);
}

#[test]
fn typing_in_the_palette_puts_the_cursor_back_on_the_first_match() {
	let mut store = store();
	moves::open_palette(&mut store, PaletteKind::Command);
	moves::palette_move(&mut store, 3);
	assert!(store.overlay.palette().expect("open").selected > 0);
	moves::palette_query(&mut store, "port".to_owned());
	assert_eq!(store.overlay.palette().expect("open").selected, 0);
}

#[test]
fn accepting_a_session_from_the_palette_selects_it_and_closes() {
	let mut store = store();
	moves::open_palette(&mut store, PaletteKind::Command);
	moves::palette_query(&mut store, "grep".to_owned());
	moves::palette_accept(&mut store);

	assert_eq!(store.selected, Some(id("grep")));
	assert!(!store.overlay.is_open());
}

#[test]
fn accepting_a_command_from_the_palette_carries_it_out() {
	let mut store = store();
	let open = store.terminal.open;
	moves::open_palette(&mut store, PaletteKind::Command);
	moves::palette_query(&mut store, "terminal panel".to_owned());
	moves::palette_accept(&mut store);
	assert_ne!(store.terminal.open, open, "the command matched a row and did nothing");
}

#[test]
fn accepting_a_model_changes_only_the_selected_session() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	let other = store.session(&id("grep")).expect("seeded").model.clone();

	moves::open_palette(&mut store, PaletteKind::Model);
	moves::palette_query(&mut store, "codex".to_owned());
	let rows = moves::palette_rows(&store);
	let taken = rows.first().expect("a codex model").key.clone();
	moves::palette_accept(&mut store);

	assert_eq!(store.session(&id("themes")).expect("seeded").model, taken);
	assert_eq!(store.session(&id("grep")).expect("seeded").model, other);
}

#[test]
fn the_palette_marks_the_row_that_is_already_current() {
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	let model = store.selected_session().expect("selected").model.clone();
	moves::open_palette(&mut store, PaletteKind::Model);
	let rows = moves::palette_rows(&store);
	let current: Vec<&str> = rows
		.iter()
		.filter(|row| row.current)
		.map(|row| row.key.as_str())
		.collect();
	assert_eq!(current, vec![model.as_str()]);
}

#[test]
fn every_command_the_palette_offers_does_something() {
	// The defect this closes: a command row added to the table with no arm in
	// `run_action`, which shows in the palette, is selectable, and reports
	// nothing wrong when taken.
	for (key, label) in moves::actions() {
		let mut store = store();
		let before = store.clone();
		moves::run_action(&mut store, key);
		assert_ne!(
			store, before,
			"the palette offers {label:?} ({key}) and running it changed nothing"
		);
		assert!(
			store
				.notice
				.as_deref()
				.is_none_or(|notice| !notice.contains("No command")),
			"{key} is offered by the palette and has no arm in run_action"
		);
	}
}

#[test]
fn an_unknown_command_key_says_so_rather_than_failing_silently() {
	let mut store = store();
	moves::run_action(&mut store, "not-a-command");
	assert!(
		store
			.notice
			.as_deref()
			.is_some_and(|notice| notice.contains("not-a-command"))
	);
}

#[test]
fn a_notice_retires_on_its_own() {
	let mut store = store();
	settle(&mut store);
	moves::notify(&mut store, "Model set to x");
	assert!(store.notice.is_some());

	let until = store
		.notice_until
		.expect("a notice with no deadline never leaves the screen");
	assert!(!moves::tick(&mut store, until - 1));
	assert!(store.notice.is_some());
	assert!(moves::tick(&mut store, until));
	assert!(store.notice.is_none());
}

#[test]
fn opening_a_settings_page_leaves_the_conversation_and_comes_back_to_it() {
	let mut store = store();
	let selected = store.selected.clone();

	moves::open_settings(&mut store, SettingsPage::Models);
	assert_eq!(store.route, Route::Settings(SettingsPage::Models));

	moves::close_settings(&mut store);
	assert_eq!(store.route, Route::Chat);
	assert_eq!(store.selected, selected, "settings dropped the selected session");
}

#[test]
fn flipping_the_appearance_twice_returns_to_where_it_started() {
	let mut store = store();
	let before = store.settings.appearance;
	moves::run_action(&mut store, "flip-appearance");
	assert_ne!(store.settings.appearance, before);
	moves::run_action(&mut store, "flip-appearance");
	assert_eq!(store.settings.appearance, before);
}

#[test]
fn setting_the_appearance_is_idempotent() {
	let mut store = store();
	moves::set_appearance(&mut store, Appearance::Light);
	moves::set_appearance(&mut store, Appearance::Light);
	assert_eq!(store.settings.appearance, Appearance::Light);
}

#[test]
fn a_reply_that_lands_a_whole_block_keeps_the_blocks_it_already_landed() {
	// The defect: a streaming reveal that overwrites the last block would eat a
	// tool call or a diff as soon as prose resumed after it.
	let mut store = store();
	moves::select(&mut store, &id("themes"));
	type_and_send(&mut store, "read the theme loader");

	let mut clock = 0;
	while store.selected_session().expect("selected").run.is_some() && clock < 120_000 {
		clock += 16;
		moves::tick(&mut store, clock);
	}

	let reply = store
		.selected_session()
		.expect("selected")
		.messages
		.last()
		.expect("reply");
	let kinds: Vec<&str> = reply
		.blocks
		.iter()
		.map(|block| match block {
			Block::Text(_) => "text",
			Block::Code { .. } => "code",
			Block::Tool { .. } => "tool",
			Block::Diff { .. } => "diff",
		})
		.collect();
	assert!(kinds.contains(&"tool"), "the tool call was overwritten by the prose after it");
	assert!(kinds.contains(&"code"));
	assert!(kinds.iter().filter(|kind| **kind == "text").count() >= 2);
}

#[test]
fn answering_a_waiting_session_sends_the_answer() {
	let mut store = store();
	moves::select(&mut store, &id("modifier"));
	let before = store.selected_session().expect("selected").messages.len();

	moves::answer(&mut store, "ctrl-backtick");

	let session = store.selected_session().expect("selected");
	assert_eq!(session.messages.len(), before + 2);
	assert_eq!(session.status, Activity::Working);
}

#[test]
fn the_window_only_asks_for_frames_while_something_is_in_flight() {
	let mut store = store();
	settle(&mut store);
	assert!(!store.animating());

	moves::select(&mut store, &id("themes"));
	type_and_send(&mut store, "read it");
	assert!(store.animating());

	moves::interrupt(&mut store);
	assert!(!store.animating(), "an interrupted session keeps the window redrawing forever");
}

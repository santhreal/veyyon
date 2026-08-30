//! WHY THIS SUITE EXISTS.
//!
//! Every interaction in this window is a move over the store rather than a
//! socket call, so a defect here is invisible in a screenshot and invisible to
//! a type check: a conversation list nobody can select from, a composer that
//! takes characters and sends nothing, a title that never takes the name of
//! what was written, a palette whose cursor and whose accept read two different
//! lists.
//!
//! The class it closes is one shape: a move that reports success while leaving
//! the store where it was, or leaving it somewhere the window cannot draw
//! (nothing selected, a caret past the end of a draft, a palette cursor past
//! its last row).
//!
//! Each test drives the real move against a real opened store, in the order the
//! window calls them.
//!
//! WHAT IT DOES NOT CATCH. Anything about drawing: layout, colour, hit testing,
//! focus, or whether the element that calls a move is reachable with a pointer.
//! A move proved here and wired to nothing passes; the windowed suite in
//! `the_keyboard_reaches_every_route.rs` covers the wiring.

use super::{
	model::{
		Appearance, Block, Message, Route, SESSION_TITLE_UNTITLED, SIDEBAR_DEFAULT, SIDEBAR_MAX,
		SIDEBAR_MIN, SessionId, SettingsPage, Store,
	},
	moves,
};

fn store() -> Store {
	Store::opened_in("checkout", "/repo/checkout")
}

/// Type into the selected conversation and send, the way the composer does.
fn type_and_send(store: &mut Store, text: &str) -> bool {
	moves::set_draft(store, text.to_owned(), text.len());
	moves::send(store)
}

// ---- what the window opens on ----

#[test]
fn the_window_opens_on_one_empty_conversation_in_the_directory_it_was_started_in() {
	let store = store();
	assert_eq!(store.projects.len(), 1, "the checkout the process was started in");
	assert_eq!(store.projects[0].name, "checkout");
	assert_eq!(store.projects[0].path, "/repo/checkout");
	assert_eq!(store.sessions.len(), 1, "one conversation to type into");
	assert_eq!(
		store.selected.as_ref(),
		Some(&store.sessions[0].id),
		"a window with nothing selected has a composer pointing at nothing"
	);
	assert_eq!(store.sessions[0].title, SESSION_TITLE_UNTITLED);
	assert!(store.sessions[0].messages.is_empty(), "no fixture transcript");
	assert_eq!(store.route, Route::Chat);
	assert!(!store.overlay.is_open());
	assert!(store.notice.is_none());
}

#[test]
fn every_conversation_belongs_to_a_project_the_store_can_name() {
	let mut store = store();
	moves::new_session(&mut store);
	for session in &store.sessions {
		assert!(
			store.project(&session.project).is_some(),
			"{} belongs to a checkout the sidebar cannot draw a heading for",
			session.id.as_str()
		);
	}
}

// ---- selection ----

#[test]
fn selecting_a_conversation_that_is_not_there_leaves_the_selection_alone() {
	let mut store = store();
	let was = store.selected.clone();
	moves::select(&mut store, &SessionId::new("nothing-like-this"));
	assert_eq!(store.selected, was, "the composer would point at nothing");
}

#[test]
fn selecting_leaves_settings_and_closes_the_palette() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	moves::open_settings(&mut store, SettingsPage::Keys);
	moves::open_palette(&mut store);
	moves::select(&mut store, &first);
	assert_eq!(store.route, Route::Chat, "a selection that lands behind settings is invisible");
	assert!(!store.overlay.is_open());
}

#[test]
fn cycling_walks_the_drawn_order_and_wraps_at_both_ends() {
	let mut store = store();
	moves::new_session(&mut store);
	moves::new_session(&mut store);
	let order = store.visible_order();
	assert_eq!(order.len(), 3);

	moves::select(&mut store, &order[0]);
	for step in 1..=order.len() {
		moves::cycle(&mut store, true);
		let expected = &order[step % order.len()];
		assert_eq!(store.selected.as_ref(), Some(expected), "forward step {step}");
	}
	for step in 1..=order.len() {
		moves::cycle(&mut store, false);
		let expected = &order[(order.len() - step) % order.len()];
		assert_eq!(store.selected.as_ref(), Some(expected), "backward step {step}");
	}
}

#[test]
fn the_drawn_order_is_the_order_the_keyboard_walks() {
	// The sidebar draws `rows` per project and the keyboard walks
	// `visible_order`. Two functions, one order, or an arrow key lands
	// somewhere the eye did not expect.
	let mut store = store();
	moves::new_session(&mut store);
	store.now_ms = 500;
	type_and_send(&mut store, "the newest thing said");

	let project = store.projects[0].id.clone();
	let drawn: Vec<SessionId> = store
		.rows(&project)
		.into_iter()
		.map(|session| session.id.clone())
		.collect();
	assert_eq!(drawn, store.visible_order());
	assert_eq!(
		drawn.first(),
		store.selected.as_ref(),
		"the conversation just written in is not at the top of the list"
	);
}

#[test]
fn a_folded_checkout_is_out_of_the_keyboards_reach() {
	let mut store = store();
	let project = store.projects[0].id.clone();
	moves::toggle_project(&mut store, &project);
	assert!(store.visible_order().is_empty(), "an arrow key would select an invisible row");
	moves::toggle_project(&mut store, &project);
	assert_eq!(store.visible_order().len(), 1);
}

// ---- writing ----

#[test]
fn sending_appends_what_was_written_and_nothing_else() {
	let mut store = store();
	store.now_ms = 1_200;
	assert!(type_and_send(&mut store, "  look at input.rs  "));

	let session = store.selected_session().expect("still selected");
	assert_eq!(session.messages.len(), 1, "one message, and no reply invented beside it");
	assert_eq!(session.messages[0].text(), "look at input.rs", "sent untrimmed");
	assert_eq!(session.messages[0].at_ms, 1_200, "stamped with the store's clock");
	assert_eq!(session.draft, "", "the draft outlived the send");
	assert_eq!(session.caret, 0);
	assert_eq!(session.updated_ms, 1_200);
}

#[test]
fn an_empty_or_blank_draft_sends_nothing() {
	let mut store = store();
	for blank in ["", "   ", "\n\t \n"] {
		assert!(!type_and_send(&mut store, blank), "{blank:?} became a message");
		assert!(store.selected_session().unwrap().messages.is_empty());
	}
}

#[test]
fn the_first_message_names_the_conversation_and_later_ones_leave_the_name_alone() {
	let mut store = store();
	assert!(type_and_send(&mut store, "why does the caret jump"));
	assert_eq!(store.selected_session().unwrap().title, "why does the caret jump");
	assert!(type_and_send(&mut store, "never mind"));
	assert_eq!(
		store.selected_session().unwrap().title,
		"why does the caret jump",
		"a conversation renamed by its last line changes name while it is read"
	);
}

#[test]
fn a_title_is_cut_at_a_word_and_never_mid_word() {
	let long = "the composer keeps the draft per conversation which is what makes switching cheap \
	            and it goes on well past what any header could show";
	let title = moves::title_from(long);
	assert!(title.chars().count() <= moves::TITLE_MAX, "{title:?} is longer than what is kept");
	assert!(long.starts_with(&title), "{title:?} is not a prefix of what was written");
	assert!(!title.ends_with(' '));
	assert!(long[title.len()..].starts_with(' '), "{title:?} stops in the middle of a word");
}

#[test]
fn a_title_from_a_single_unbroken_run_is_still_bounded() {
	let run = "x".repeat(400);
	let title = moves::title_from(&run);
	assert_eq!(title.chars().count(), moves::TITLE_MAX, "one long word has to be cut somewhere");
}

#[test]
fn a_first_line_that_fits_is_kept_whole_for_the_surfaces_to_shorten() {
	let line = "why does the caret jump when the draft is restored";
	assert_eq!(
		moves::title_from(line),
		line,
		"a line inside the bound is stored whole, so a wide header can show all of it"
	);
}

#[test]
fn a_draft_belongs_to_its_conversation() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	moves::set_draft(&mut store, "half a thought".to_owned(), 4);
	let second = moves::new_session(&mut store);
	assert_eq!(store.selected_session().unwrap().draft, "", "a new conversation starts empty");

	moves::select(&mut store, &first);
	let session = store.selected_session().unwrap();
	assert_eq!(session.draft, "half a thought", "the draft did not come back");
	assert_eq!(session.caret, 4, "the caret came back at zero, so it has to be re-navigated");

	moves::select(&mut store, &second);
	assert_eq!(store.selected_session().unwrap().draft, "");
}

#[test]
fn a_caret_never_lands_past_the_end_of_its_draft() {
	let mut store = store();
	moves::set_draft(&mut store, "short".to_owned(), 500);
	let session = store.selected_session().unwrap();
	assert_eq!(session.caret, session.draft.len(), "the field would index out of bounds");
}

// ---- what a message is made of ----

#[test]
fn a_fence_becomes_a_code_block_and_the_prose_around_it_stays_prose() {
	let message = Message::written(1, 0, "before\n```rust\nfn main() {}\n```\nafter");
	assert_eq!(message.blocks, vec![
		Block::Text("before".to_owned()),
		Block::Code { lang: "rust".to_owned(), body: "fn main() {}".to_owned() },
		Block::Text("after".to_owned()),
	]);
	assert_eq!(message.text(), "before\n\nafter", "the preview reads prose, not code");
}

#[test]
fn a_fence_with_no_language_and_a_fence_never_closed_are_both_code() {
	let plain = Message::written(1, 0, "```\nraw\n```");
	assert_eq!(plain.blocks, vec![Block::Code { lang: String::new(), body: "raw".to_owned() }]);

	// What the writer is looking at halfway through typing a block.
	let open = Message::written(2, 0, "look:\n```sh\nls -l");
	assert_eq!(open.blocks, vec![Block::Text("look:".to_owned()), Block::Code {
		lang: "sh".to_owned(),
		body: "ls -l".to_owned(),
	},]);
}

#[test]
fn text_with_no_fence_is_one_block() {
	let message = Message::written(1, 0, "one line\n\nand another");
	assert_eq!(message.blocks, vec![Block::Text("one line\n\nand another".to_owned())]);
}

#[test]
fn the_row_preview_is_the_first_line_of_the_last_thing_said() {
	let mut store = store();
	assert!(type_and_send(&mut store, "first"));
	assert!(type_and_send(&mut store, "  second line one  \nsecond line two"));
	assert_eq!(store.selected_session().unwrap().preview().as_deref(), Some("second line one"));
}

#[test]
fn a_conversation_with_only_a_code_block_has_no_preview_rather_than_a_blank_one() {
	let mut store = store();
	assert!(type_and_send(&mut store, "```\nls\n```"));
	assert_eq!(store.selected_session().unwrap().preview(), None);
}

#[test]
fn a_row_does_not_print_the_line_that_named_it_twice() {
	let mut store = store();
	assert!(type_and_send(&mut store, "why does the caret jump when the draft reloads"));
	let session = store.selected_session().unwrap();
	assert_eq!(session.title, "why does the caret jump when the draft reloads");
	assert_eq!(
		session.preview(),
		None,
		"the only message is the title, so the row has nothing else to show"
	);
}

// ---- the list ----

#[test]
fn a_new_conversation_is_selected_empty_and_named_untitled() {
	let mut store = store();
	let before = store.sessions.len();
	let id = moves::new_session(&mut store);
	assert_eq!(store.sessions.len(), before + 1);
	assert_eq!(store.selected.as_ref(), Some(&id));
	let session = store.selected_session().unwrap();
	assert_eq!(session.title, SESSION_TITLE_UNTITLED);
	assert!(session.messages.is_empty());
	assert!(session.draft.is_empty());
}

#[test]
fn two_new_conversations_never_share_an_id() {
	let mut store = store();
	let mut ids = vec![store.sessions[0].id.clone()];
	for _ in 0..8 {
		ids.push(moves::new_session(&mut store));
	}
	let count = ids.len();
	ids.sort();
	ids.dedup();
	assert_eq!(ids.len(), count, "two rows with one id are one row as far as a click is concerned");
}

#[test]
fn deleting_moves_the_selection_to_a_conversation_that_is_still_there() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	let second = moves::new_session(&mut store);
	moves::delete_session(&mut store, &second);

	assert!(store.session(&second).is_none());
	assert_eq!(store.selected.as_ref(), Some(&first));
	assert!(store.notice.is_some(), "a deletion that says nothing looks like a bug");
}

#[test]
fn deleting_something_else_leaves_the_selection_where_it_was() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	let second = moves::new_session(&mut store);
	moves::delete_session(&mut store, &first);
	assert_eq!(
		store.selected.as_ref(),
		Some(&second),
		"the selection followed a deletion of another row"
	);
}

#[test]
fn the_last_conversation_cannot_be_deleted() {
	// An empty list leaves the composer pointing at nothing, which takes a
	// keystroke and drops it.
	let mut store = store();
	let only = store.sessions[0].id.clone();
	moves::delete_session(&mut store, &only);
	assert_eq!(store.sessions.len(), 1);
	assert_eq!(store.selected.as_ref(), Some(&only));
	assert!(store.notice.is_none(), "nothing happened, so nothing is announced");
}

// ---- the notice line ----

#[test]
fn a_notice_retires_by_itself_and_says_so_once() {
	let mut store = store();
	store.now_ms = 1_000;
	moves::notify(&mut store, "Deleted something");
	let until = store
		.notice_until
		.expect("a notice with no deadline never leaves");
	assert!(until > 1_000);

	assert!(!moves::tick(&mut store, until - 1), "retired early");
	assert!(store.notice.is_some());
	assert!(moves::tick(&mut store, until), "the frame that retires it has to be reported");
	assert!(store.notice.is_none());
	assert_eq!(store.notice_until, None);
	assert!(!moves::tick(&mut store, until + 5_000), "a retired notice retires again");
}

#[test]
fn the_store_only_asks_for_a_frame_while_it_has_a_deadline() {
	let mut store = store();
	assert_eq!(store.deadline(), None, "an idle window that keeps drawing never sleeps");
	moves::notify(&mut store, "something");
	assert!(store.deadline().is_some());
	let until = store.notice_until.unwrap();
	moves::tick(&mut store, until);
	assert_eq!(store.deadline(), None);
}

// ---- the sidebar's width ----

#[test]
fn the_sidebar_width_is_clamped_at_both_ends_and_resets_to_the_default() {
	let mut store = store();
	moves::set_sidebar_width(&mut store, 40.0);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_MIN);
	moves::set_sidebar_width(&mut store, 4_000.0);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_MAX);
	moves::set_sidebar_width(&mut store, 300.0);
	assert_eq!(store.settings.sidebar_width, 300.0);
	moves::reset_sidebar_width(&mut store);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_DEFAULT);
}

#[test]
fn hiding_the_sidebar_keeps_its_width_for_when_it_comes_back() {
	let mut store = store();
	moves::set_sidebar_width(&mut store, 320.0);
	moves::toggle_sidebar(&mut store);
	assert!(!store.settings.sidebar_open);
	assert_eq!(store.settings.sidebar_width, 320.0);
	moves::toggle_sidebar(&mut store);
	assert!(store.settings.sidebar_open);
	assert_eq!(store.settings.sidebar_width, 320.0);
}

// ---- the palette ----

#[test]
fn the_palette_opens_empty_at_the_first_row_and_closes_clean() {
	let mut store = store();
	moves::open_palette(&mut store);
	let palette = store.overlay.palette().expect("open");
	assert_eq!(palette.query, "");
	assert_eq!(palette.selected, 0);
	moves::close_overlay(&mut store);
	assert!(!store.overlay.is_open());
	assert!(moves::palette_rows(&store).is_empty(), "a closed palette still has rows");
}

#[test]
fn the_palette_lists_every_conversation_and_every_command() {
	let mut store = store();
	moves::new_session(&mut store);
	moves::open_palette(&mut store);
	let rows = moves::palette_rows(&store);
	assert_eq!(
		rows.len(),
		store.sessions.len() + moves::actions().len(),
		"a row the palette does not list is a command nobody can reach"
	);
	for (key, label) in moves::actions() {
		assert!(
			rows.iter().any(|row| row.key == key && row.label == label),
			"{key} is missing from the palette"
		);
	}
	assert_eq!(
		rows.iter().filter(|row| row.current).count(),
		1,
		"exactly one row is the conversation that is open"
	);
}

#[test]
fn typing_filters_both_corpora_and_puts_the_cursor_back_on_the_first_match() {
	let mut store = store();
	assert!(type_and_send(&mut store, "the caret jumps in the composer"));
	moves::new_session(&mut store);
	moves::open_palette(&mut store);
	moves::palette_move(&mut store, 3);
	assert!(store.overlay.palette().unwrap().selected > 0);

	moves::palette_query(&mut store, "caret".to_owned());
	assert_eq!(store.overlay.palette().unwrap().selected, 0, "the cursor stayed past the matches");
	let rows = moves::palette_rows(&store);
	assert_eq!(rows.len(), 1);
	assert!(rows[0].key.starts_with("session:"));

	moves::palette_query(&mut store, "appearance".to_owned());
	let rows = moves::palette_rows(&store);
	assert_eq!(rows.len(), 1, "a command is matched on the words a reader would type");
	assert_eq!(rows[0].key, "flip-appearance");

	// Every match is visible in the row it produced. A corpus matched on
	// something the row does not print answers a query with a line that has
	// nothing to do with it.
	for query in ["a", "conv", "list", "settings", "light", "delete"] {
		moves::palette_query(&mut store, query.to_owned());
		for row in moves::palette_rows(&store) {
			assert!(
				row.label.to_lowercase().contains(query),
				"{query:?} returned {:?}, which does not contain it",
				row.label
			);
		}
	}

	moves::palette_query(&mut store, "no such thing".to_owned());
	assert!(moves::palette_rows(&store).is_empty());
}

#[test]
fn the_palette_cursor_clamps_at_both_ends_rather_than_wrapping() {
	let mut store = store();
	moves::open_palette(&mut store);
	let count = moves::palette_rows(&store).len();
	assert!(count > 1);

	moves::palette_move(&mut store, -5);
	assert_eq!(store.overlay.palette().unwrap().selected, 0, "a held up arrow never settles");
	moves::palette_move(&mut store, count as isize + 5);
	assert_eq!(store.overlay.palette().unwrap().selected, count - 1);
}

#[test]
fn accepting_a_conversation_row_selects_it_and_closes_the_sheet() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	let second = moves::new_session(&mut store);
	moves::select(&mut store, &first);

	moves::open_palette(&mut store);
	let rows = moves::palette_rows(&store);
	let at = rows
		.iter()
		.position(|row| row.key == format!("session:{}", second.as_str()))
		.expect("the other conversation is in the list");
	moves::palette_move(&mut store, at as isize);
	moves::palette_accept(&mut store);

	assert_eq!(store.selected.as_ref(), Some(&second));
	assert!(!store.overlay.is_open());
}

#[test]
fn accepting_with_no_rows_closes_nothing_and_changes_nothing() {
	let mut store = store();
	moves::open_palette(&mut store);
	moves::palette_query(&mut store, "nothing matches this".to_owned());
	let before = store.clone();
	moves::palette_accept(&mut store);
	assert_eq!(store, before, "an accept over an empty list did something");
}

#[test]
fn every_command_the_palette_offers_actually_does_something() {
	// The class this closes: a command row wired to a key the runner does not
	// know, which notifies "No command named …" and looks like a crash.
	let mut store = store();
	moves::new_session(&mut store);
	for (key, label) in moves::actions() {
		let mut probe = store.clone();
		probe.notice = None;
		moves::run_action(&mut probe, key);
		assert!(
			probe.notice.as_deref() != Some(&format!("No command named {key}")),
			"{label} ({key}) is offered and not implemented"
		);
		probe.notice = None;
		probe.notice_until = None;
		assert_ne!(probe, store, "{label} ({key}) changed nothing at all");
	}
}

#[test]
fn an_unknown_command_says_so_instead_of_failing_silently() {
	let mut store = store();
	moves::run_action(&mut store, "no-such-command");
	assert_eq!(store.notice.as_deref(), Some("No command named no-such-command"));
}

// ---- settings ----

#[test]
fn every_settings_page_is_reachable_and_leaving_returns_to_the_conversation() {
	let mut store = store();
	for page in SettingsPage::ALL {
		moves::open_settings(&mut store, page);
		assert_eq!(store.route, Route::Settings(page), "{} is unreachable", page.label());
		assert!(!store.overlay.is_open(), "the palette stayed over the page it opened");
	}
	moves::close_settings(&mut store);
	assert_eq!(store.route, Route::Chat);
}

#[test]
fn every_settings_page_has_a_label_of_its_own() {
	let mut labels: Vec<&str> = SettingsPage::ALL.iter().map(|page| page.label()).collect();
	let count = labels.len();
	labels.sort_unstable();
	labels.dedup();
	assert_eq!(labels.len(), count, "two pages with one name are one row in the nav");
	assert!(labels.iter().all(|label| !label.is_empty()));
}

#[test]
fn the_appearance_flips_between_exactly_two_states() {
	let mut store = store();
	assert_eq!(store.settings.appearance, Appearance::Dark);
	moves::run_action(&mut store, "flip-appearance");
	assert_eq!(store.settings.appearance, Appearance::Light);
	moves::run_action(&mut store, "flip-appearance");
	assert_eq!(store.settings.appearance, Appearance::Dark);

	moves::set_appearance(&mut store, Appearance::Light);
	assert_eq!(store.settings.appearance, Appearance::Light);
}

#[test]
fn the_text_size_is_clamped_to_what_the_window_can_draw() {
	use super::model::{FONT_MAX, FONT_MIN};
	let mut store = store();
	// An integer sweep, because stepping by a float accumulates.
	for step in 0..=40 {
		let asked = 5.0 + step as f32;
		moves::set_font_size(&mut store, asked);
		let got = store.settings.font_size;
		assert!(
			(FONT_MIN..=FONT_MAX).contains(&got),
			"{asked} became {got}, which is outside what the window draws"
		);
		if (FONT_MIN..=FONT_MAX).contains(&asked) {
			assert_eq!(got, asked);
		}
	}
}

#[test]
fn grouping_by_checkout_is_a_two_way_switch() {
	let mut store = store();
	let was = store.settings.group_by_folder;
	moves::toggle_group_by_folder(&mut store);
	assert_ne!(store.settings.group_by_folder, was);
	moves::toggle_group_by_folder(&mut store);
	assert_eq!(store.settings.group_by_folder, was);
}

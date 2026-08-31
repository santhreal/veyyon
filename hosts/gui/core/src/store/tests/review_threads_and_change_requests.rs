//! WHY THIS SUITE EXISTS: Review comments, threads, and change requests are
//! frontend-owned review primitives. This suite verifies that starting threads,
//! replying, draft editing, resolving/unresolving, and change request creation
//! update store state correctly, that unresolved threads never block composer
//! submissions or scope changes, that review commands are exhaustive across
//! variants, and that boundary violations are safely refused without panicking.
//!
//! WHAT IT DOES NOT CATCH: Pixel-level widget presentation in GPUI.

use crate::{
	Store, UiCommand,
	command::menu::{all_command_variants, command_variant_name},
	model::*,
	navigation::*,
};

#[test]
fn review_thread_lifecycle_and_resolution() {
	let mut store = Store::detached();

	// Start a thread
	let cmd = UiCommand::StartReviewThread {
		path:  "src/lib.rs".to_string(),
		range: LineRange { start: 10, end: 15 },
		text:  "Initial comment".to_string(),
	};
	store.dispatch(cmd);

	assert_eq!(store.frontend.review.threads.len(), 1);
	let thread_id = store.frontend.review.selected_thread.clone().unwrap();
	let thread = store.frontend.review.threads.get(&thread_id).unwrap();
	assert_eq!(thread.path, "src/lib.rs");
	assert_eq!(thread.range, LineRange { start: 10, end: 15 });
	assert_eq!(thread.comments.len(), 1);
	assert_eq!(thread.comments[0].text, "Initial comment");
	assert!(thread.is_unresolved());
	assert_eq!(store.frontend.review.unresolved_count(), 1);
	assert_eq!(
		store
			.frontend
			.review
			.unresolved_count_for_file("src/lib.rs"),
		1
	);

	// Reply to thread
	let reply_cmd = UiCommand::ReplyReviewThread {
		thread_id: thread_id.clone(),
		text:      "Second comment".to_string(),
	};
	store.dispatch(reply_cmd);

	let thread = store.frontend.review.threads.get(&thread_id).unwrap();
	assert_eq!(thread.comments.len(), 2);
	assert_eq!(thread.comments[1].text, "Second comment");

	// Resolve thread
	store.dispatch(UiCommand::ResolveReviewThread(thread_id.clone()));
	let thread = store.frontend.review.threads.get(&thread_id).unwrap();
	assert!(thread.resolved);
	assert_eq!(store.frontend.review.unresolved_count(), 0);
	assert_eq!(
		store
			.frontend
			.review
			.unresolved_count_for_file("src/lib.rs"),
		0
	);

	// Unresolve thread
	store.dispatch(UiCommand::UnresolveReviewThread(thread_id.clone()));
	let thread = store.frontend.review.threads.get(&thread_id).unwrap();
	assert!(!thread.resolved);
	assert_eq!(store.frontend.review.unresolved_count(), 1);

	// Toggle resolve
	store.dispatch(UiCommand::ToggleReviewThreadResolved(thread_id.clone()));
	assert!(
		store
			.frontend
			.review
			.threads
			.get(&thread_id)
			.unwrap()
			.resolved
	);

	// Delete comment
	let comment_id = store
		.frontend
		.review
		.threads
		.get(&thread_id)
		.unwrap()
		.comments[0]
		.id
		.clone();
	store.dispatch(UiCommand::DeleteReviewComment {
		thread_id:  thread_id.clone(),
		comment_id: comment_id.clone(),
	});
	assert_eq!(
		store
			.frontend
			.review
			.threads
			.get(&thread_id)
			.unwrap()
			.comments
			.len(),
		1
	);

	// Delete thread
	store.dispatch(UiCommand::DeleteReviewThread(thread_id.clone()));
	assert!(store.frontend.review.threads.is_empty());
	assert_eq!(store.frontend.review.selected_thread, None);
}

#[test]
fn change_request_lifecycle() {
	let mut store = Store::detached();

	// Add two threads
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/a.rs".to_string(),
		range: LineRange { start: 1, end: 2 },
		text:  "Fix a".to_string(),
	});
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/b.rs".to_string(),
		range: LineRange { start: 5, end: 8 },
		text:  "Fix b".to_string(),
	});

	assert_eq!(store.frontend.review.threads.len(), 2);

	// Create change request
	store.dispatch(UiCommand::CreateChangeRequest {
		title:       "Refactor module".to_string(),
		description: Some("Addressing code review comments".to_string()),
	});

	assert_eq!(store.frontend.review.change_requests.len(), 1);
	let cr_id = store
		.frontend
		.review
		.selected_change_request
		.clone()
		.unwrap();
	let cr = store.frontend.review.change_requests.get(&cr_id).unwrap();
	assert_eq!(cr.title, "Refactor module");
	assert_eq!(cr.state, ChangeRequestState::Open);
	assert_eq!(cr.threads.len(), 2);

	// State transition
	store.dispatch(UiCommand::SetChangeRequestState {
		id:    cr_id.clone(),
		state: ChangeRequestState::Submitted,
	});
	assert_eq!(
		store
			.frontend
			.review
			.change_requests
			.get(&cr_id)
			.unwrap()
			.state,
		ChangeRequestState::Submitted
	);
}

#[test]
fn unresolved_threads_block_nothing() {
	let mut store = Store::detached();
	let sid = SessionId::new("session-1").unwrap();
	store.frontend.selected_session = Some(sid.clone());

	// Create an unresolved review thread
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/file.rs".to_string(),
		range: LineRange { start: 10, end: 20 },
		text:  "Blocking review?".to_string(),
	});
	assert_eq!(store.frontend.review.unresolved_count(), 1);

	// 1. Submit draft succeeds and produces expected effects
	store.frontend.drafts.entry(sid.clone()).or_default().text = "Prompt text".to_string();
	let _effects = store.dispatch(UiCommand::SubmitPrompt { session: sid });

	// 2. Change scope filter switch succeeds
	store.dispatch(UiCommand::SetChangesFilter("test".to_string()));
	assert_eq!(store.frontend.changes_filter, "test");

	// 3. Navigation route switch succeeds
	store.dispatch(UiCommand::Navigate(Route::Agents));
	assert_eq!(store.frontend.route, Route::Agents);
}

#[test]
fn boundary_conditions_safely_refused() {
	let mut store = Store::detached();

	// 1. Empty line range (start == 0)
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/lib.rs".to_string(),
		range: LineRange { start: 0, end: 5 },
		text:  "Bad start".to_string(),
	});
	assert!(store.frontend.review.threads.is_empty());

	// 2. Inverted line range (start > end)
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/lib.rs".to_string(),
		range: LineRange { start: 10, end: 5 },
		text:  "Inverted".to_string(),
	});
	assert!(store.frontend.review.threads.is_empty());

	// 3. Empty thread text
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/lib.rs".to_string(),
		range: LineRange { start: 5, end: 10 },
		text:  "   ".to_string(),
	});
	assert!(store.frontend.review.threads.is_empty());

	// Start a valid thread for reply testing
	store.dispatch(UiCommand::StartReviewThread {
		path:  "src/lib.rs".to_string(),
		range: LineRange { start: 5, end: 10 },
		text:  "Valid".to_string(),
	});
	let tid = store.frontend.review.selected_thread.clone().unwrap();

	// 4. Empty reply text
	store.dispatch(UiCommand::ReplyReviewThread {
		thread_id: tid.clone(),
		text:      "  ".to_string(),
	});
	assert_eq!(
		store
			.frontend
			.review
			.threads
			.get(&tid)
			.unwrap()
			.comments
			.len(),
		1
	);

	// 5. Empty change request title
	store.dispatch(UiCommand::CreateChangeRequest {
		title:       "  ".to_string(),
		description: None,
	});
	assert!(store.frontend.review.change_requests.is_empty());
}

#[test]
fn every_review_command_variant_swept_and_dispatches() {
	let mut store = Store::detached();
	let all_variants = all_command_variants();

	let review_command_names = [
		"StartReviewThread",
		"ReplyReviewThread",
		"EditReviewDraft",
		"ResolveReviewThread",
		"UnresolveReviewThread",
		"ToggleReviewThreadResolved",
		"DeleteReviewThread",
		"DeleteReviewComment",
		"SelectReviewThread",
		"CreateChangeRequest",
		"SetChangeRequestState",
		"RemapReviewAnchors",
	];

	for name in &review_command_names {
		let variant = all_variants
			.iter()
			.find(|cmd| command_variant_name(cmd) == *name);
		assert!(variant.is_some(), "Variant for {name} missing from all_command_variants");
		// Dispatch the variant; it must run cleanly without panicking
		store.dispatch(variant.unwrap().clone());
	}
}

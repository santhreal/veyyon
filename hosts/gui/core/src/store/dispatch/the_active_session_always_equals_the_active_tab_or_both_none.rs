//! WHY THIS SUITE EXISTS. An active session discrepancy across tabs and spaces
//! causes transcript rendering desynchronization where the canvas displays one
//! session while the tab strip highlights another. This suite enforces the
//! structural invariant that `frontend.selected_session` equals the active tab
//! session of the active space, or both are `None`, across arbitrary command
//! sequences including boundary cases.
//!
//! What this closes: drift between tab strip selection and conversation
//! rendering. What it does not catch: font measurement errors within tab
//! labels.

#[cfg(test)]
mod tests {
	use crate::{Store, UiCommand, model::SessionId};

	fn sample_session(name: &str) -> SessionId {
		SessionId::new(name).unwrap()
	}

	fn assert_invariant(store: &Store) {
		let space_active_session = store.frontend.spaces.active_session();
		assert_eq!(
			store.frontend.selected_session, space_active_session,
			"selected_session must strictly match the active tab session of the active space"
		);
		assert_eq!(
			store
				.frontend
				.spaces
				.active()
				.and_then(|s| s.active_tab)
				.is_some(),
			store.frontend.selected_session.is_some(),
			"active_tab index and selected_session must both be Some or both be None"
		);
	}

	#[test]
	fn tab_and_space_operations_preserve_session_consistency_invariant() {
		let mut store = Store::detached();
		assert_invariant(&store);

		let s1 = sample_session("s1");
		let s2 = sample_session("s2");
		let s3 = sample_session("s3");

		// Open tabs
		store.dispatch(UiCommand::OpenTab(s1.clone()));
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, Some(s1.clone()));

		store.dispatch(UiCommand::OpenTab(s2.clone()));
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, Some(s2.clone()));

		store.dispatch(UiCommand::OpenTab(s3.clone()));
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, Some(s3.clone()));

		// Move tab to its own index (identity reorder)
		store.dispatch(UiCommand::MoveTab { from: 1, to: 1 });
		assert_invariant(&store);

		// Move tab to the ends
		store.dispatch(UiCommand::MoveTab { from: 2, to: 0 });
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, Some(s3.clone()));

		// Out-of-bounds tab move: must be refused without panicking
		store.dispatch(UiCommand::MoveTab { from: 10, to: 0 });
		assert_invariant(&store);
		store.dispatch(UiCommand::MoveTab { from: 0, to: 10 });
		assert_invariant(&store);

		// Select tab by index
		store.dispatch(UiCommand::SelectTab(1));
		assert_invariant(&store);

		// Out-of-bounds tab select: refused cleanly
		store.dispatch(UiCommand::SelectTab(99));
		assert_invariant(&store);

		// Tab cycling
		store.dispatch(UiCommand::CycleTabs { forward: true });
		assert_invariant(&store);
		store.dispatch(UiCommand::CycleTabs { forward: false });
		assert_invariant(&store);

		// Create and switch space
		store.dispatch(UiCommand::CreateSpace { name: "Space 2".to_owned() });
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, None);

		// Cycling tabs in empty space terminates and stays put
		store.dispatch(UiCommand::CycleTabs { forward: true });
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, None);

		// One tab in space: cycling terminates and stays put
		store.dispatch(UiCommand::OpenTab(s1.clone()));
		assert_invariant(&store);
		store.dispatch(UiCommand::CycleTabs { forward: true });
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, Some(s1.clone()));

		// Close the only tab of a space -> both become None
		store.dispatch(UiCommand::CloseTab { index: 0, force: true });
		assert_invariant(&store);
		assert_eq!(store.frontend.selected_session, None);

		// Close active space -> switches back to first space and restores active tab
		let space_2_id = store.frontend.spaces.active_space_id().unwrap();
		store.dispatch(UiCommand::CloseSpace(space_2_id));
		assert_invariant(&store);
		assert!(store.frontend.selected_session.is_some());
	}
}

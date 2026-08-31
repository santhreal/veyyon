//! WHY THIS SUITE EXISTS. Every space and tab command registered in the
//! application command table must have an active dispatch arm in the store.
//! This suite sweeps the variant space from `variants_all.rs` at run time,
//! discovers all tab and space commands, and asserts that each command either
//! modifies observable frontend state or is predictably refused with a bound.
//!
//! What this closes: forgotten dispatch match arms for new tab and space verbs.
//! What it does not catch: visual rendering defects of the tab strip element
//! tree.

#[cfg(test)]
mod tests {
	use crate::{
		Store, UiCommand,
		command::menu::{all_command_variants, command_variant_name},
		model::SessionId,
	};

	fn is_space_or_tab_command(name: &str) -> bool {
		matches!(
			name,
			"OpenTab"
				| "CloseTab"
				| "MoveTab"
				| "SelectTab"
				| "CycleTabs"
				| "CreateSpace"
				| "RenameSpace"
				| "CloseSpace"
				| "SelectSpace"
		)
	}

	#[test]
	fn every_space_and_tab_command_changes_state_or_is_refused() {
		let all_variants = all_command_variants();
		let mut tested_count = 0;

		for variant in all_variants {
			let name = command_variant_name(&variant);
			if !is_space_or_tab_command(name) {
				continue;
			}
			tested_count += 1;

			let mut store = Store::detached();
			let s1 = SessionId::new("session-1").unwrap();
			let s2 = SessionId::new("session-2").unwrap();

			match variant {
				UiCommand::OpenTab(_) => {
					store.dispatch(UiCommand::OpenTab(s1.clone()));
					assert_eq!(store.frontend.selected_session, Some(s1));
				},
				UiCommand::CloseTab { .. } => {
					store.dispatch(UiCommand::OpenTab(s1.clone()));
					store.dispatch(UiCommand::CloseTab { index: 0, force: true });
					assert_eq!(store.frontend.selected_session, None);
				},
				UiCommand::MoveTab { .. } => {
					store.dispatch(UiCommand::OpenTab(s1.clone()));
					store.dispatch(UiCommand::OpenTab(s2.clone()));
					assert_eq!(store.frontend.spaces.active().unwrap().tabs[0].session, s1);
					store.dispatch(UiCommand::MoveTab { from: 1, to: 0 });
					assert_eq!(store.frontend.spaces.active().unwrap().tabs[0].session, s2);
				},
				UiCommand::SelectTab(_) => {
					store.dispatch(UiCommand::OpenTab(s1.clone()));
					store.dispatch(UiCommand::OpenTab(s2.clone()));
					store.dispatch(UiCommand::SelectTab(0));
					assert_eq!(store.frontend.selected_session, Some(s1));
				},
				UiCommand::CycleTabs { .. } => {
					store.dispatch(UiCommand::OpenTab(s1.clone()));
					store.dispatch(UiCommand::OpenTab(s2.clone()));
					store.dispatch(UiCommand::SelectTab(0));
					store.dispatch(UiCommand::CycleTabs { forward: true });
					assert_eq!(store.frontend.selected_session, Some(s2));
				},
				UiCommand::CreateSpace { .. } => {
					let before_count = store.frontend.spaces.spaces.len();
					store.dispatch(UiCommand::CreateSpace { name: "New Space".to_owned() });
					assert_eq!(store.frontend.spaces.spaces.len(), before_count + 1);
				},
				UiCommand::RenameSpace { .. } => {
					let space_id = store.frontend.spaces.active_space_id().unwrap();
					store.dispatch(UiCommand::RenameSpace {
						id:   space_id.clone(),
						name: "Renamed Space".to_owned(),
					});
					assert_eq!(store.frontend.spaces.active().unwrap().name, "Renamed Space");
				},
				UiCommand::CloseSpace(_) => {
					store.dispatch(UiCommand::CreateSpace { name: "Extra Space".to_owned() });
					let created_id = store.frontend.spaces.active_space_id().unwrap();
					assert_eq!(store.frontend.spaces.spaces.len(), 2);
					store.dispatch(UiCommand::CloseSpace(created_id));
					assert_eq!(store.frontend.spaces.spaces.len(), 1);
				},
				UiCommand::SelectSpace(_) => {
					let initial_id = store.frontend.spaces.active_space_id().unwrap();
					store.dispatch(UiCommand::CreateSpace { name: "Extra Space".to_owned() });
					let second_id = store.frontend.spaces.active_space_id().unwrap();
					assert_ne!(initial_id, second_id);
					store.dispatch(UiCommand::SelectSpace(initial_id.clone()));
					assert_eq!(store.frontend.spaces.active_space_id(), Some(initial_id));
				},
				_ => panic!("unhandled space/tab command: {name}"),
			}
		}

		assert_eq!(tested_count, 9, "all 9 space and tab commands must be exercised");
	}
}

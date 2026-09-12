//! WHY: palette filtering discarded visible subtitles, so a provider/model
//! query could not select a model whose display name differed from its
//! identifier. This covers title/subtitle matching, ranking and dispatch across
//! palette modes. Host catalog discovery and native input delivery are covered
//! separately.

use strum::IntoEnumIterator;
use veyyon_desktop_surface::{
	Intent, ModelChoice, ModelControl, ModelOption, PaletteItem, PaletteMode, PaletteState,
};

#[test]
fn a_model_identifier_selects_the_model_with_a_different_display_name() {
	let choice = ModelChoice::new("local", "compact-model");
	let mut palette = PaletteState::from_models(&ModelControl {
		current: None,
		options: vec![ModelOption {
			choice:    choice.clone(),
			name:      "Compact Model (local)".to_string(),
			reasoning: false,
			input:     vec![],
		}],
	});
	for query in ["local/compact-model", "LOCAL/COMPACT-MODEL", "Compact Model"] {
		palette.set_query(query);
		assert_eq!(palette.run_intent(), Some(Intent::SelectModel(choice.clone())), "{query}");
	}
}

#[test]
fn every_mode_matches_both_labels_without_duplicate_results_or_unstable_ties() {
	for mode in PaletteMode::iter() {
		let mut palette = PaletteState::new(mode);
		let mut identity = PaletteItem::command(1, "Friendly name", Intent::AbortTurn, None);
		identity.subtitle = Some("vendor/model".to_string());
		let title = PaletteItem::command(2, "vendor/model", Intent::AbortTurn, None);
		let mut both = title.clone();
		both.id = 3;
		both.subtitle = Some("vendor/model".to_string());
		let mut partial = PaletteItem::command(4, "vendor/model-extra", Intent::AbortTurn, None);
		partial.subtitle = Some("vendor/model".to_string());
		palette.set_items(vec![partial, identity, title, both]);
		for query in ["vendor/model", "VENDOR/MODEL"] {
			palette.set_query(query);
			assert_eq!(
				palette
					.filtered_items()
					.iter()
					.map(|item| item.id)
					.collect::<Vec<_>>(),
				vec![4, 1, 2, 3],
				"{mode:?}: {query}",
			);
		}
		palette.set_query("Friendly");
		assert_eq!(palette.selected_item().map(|item| item.id), Some(1), "{mode:?}");
		palette.set_query("missing");
		assert!(palette.filtered_items().is_empty(), "{mode:?}");
		assert!(palette.run_intent().is_none(), "{mode:?}");
		palette.set_query("");
		assert_eq!(
			palette
				.filtered_items()
				.iter()
				.map(|item| item.id)
				.collect::<Vec<_>>(),
			vec![4, 1, 2, 3]
		);
	}
}

#[test]
fn command_descriptions_are_searchable_without_losing_slash_names() {
	let mut palette = PaletteState::commands();
	for item in palette.items().to_vec() {
		let description = item
			.subtitle
			.expect("every command has a visible action description");
		for query in [item.title, description] {
			palette.set_query(query.clone());
			assert_eq!(palette.selected_item().map(|selected| selected.id), Some(item.id), "{query}");
		}
	}
	for query in ["/new", "new session", "CREATE A NEW SESSION"] {
		palette.set_query(query);
		assert_eq!(palette.run_intent(), Some(Intent::NewSession), "{query}");
	}
}

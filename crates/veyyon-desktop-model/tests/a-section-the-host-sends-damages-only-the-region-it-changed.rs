//! WHY: a section that repainted the whole window hid a region that was
//! never marked, and one that marked a single band left a stale neighbour on
//! screen. The damage a section causes is what the window repaints, so a
//! section reduced with the wrong damage is drawn stale until something else
//! marks it.
//!
//! THE CLASS THIS CLOSES:
//! A snapshot section reduced to damage that does not cover what it changed.
//! The corpus fixture is read at run time and every section in it is reduced
//! twice, once with an active session and once without, so a section added to
//! the corpus without a damage decision panics here rather than passing
//! unswept. `ALL_SECTION_NAMES` is checked against what the sweep covered, by
//! length and by name, so a section the corpus omits fails as well.
//!
//! WHAT IT DOES NOT CATCH:
//! It reads the damage the reducer returns, not the pixels the window paints
//! from it: a region marked and then drawn wrong is the surface suites'
//! subject. The fallback to a whole-window repaint is asserted only for the
//! sections whose chrome names a session.

use std::{collections::HashSet, fs, path::PathBuf};

use veyyon_desktop_model::{
	ALL_SECTION_NAMES, Damage, HostEvent, SessionId, SnapshotSection, Store, reduce,
};

#[test]
fn test_damage_decision_for_every_snapshot_section_sweep() {
	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let fixture_path = manifest_dir.join("tests/fixtures/snapshot-sections.json");
	let raw_json =
		fs::read_to_string(&fixture_path).expect("failed to read snapshot-sections fixture");
	let sections: Vec<SnapshotSection> =
		serde_json::from_str(&raw_json).expect("failed to deserialize snapshot sections");

	let mut covered_sections = HashSet::new();

	for section in sections {
		let name = section.name();
		covered_sections.insert(name);

		// Case A: Active session present
		let mut store = Store::new();
		let session_id = SessionId::from("sess-1");
		store.persisted.shell.active_session = Some(session_id.clone());

		let damage = reduce(&mut store, HostEvent::Snapshot(section.clone()));

		match name {
			"Sessions" => {
				assert!(damage.contains(&Damage::QueueAll), "Sessions must emit QueueAll");
			},
			"ActiveSession" => {
				assert!(damage.contains(&Damage::Titlebar));
				assert!(damage.contains(&Damage::Composer(session_id.clone())));
				assert!(damage.contains(&Damage::RightPanelChrome(session_id.clone())));
			},
			"Transcript" => {
				assert!(damage.contains(&Damage::TranscriptFull(session_id.clone())));
			},
			"SessionSearch" | "SessionTranscript" => {
				assert!(damage.contains(&Damage::Titlebar));
				assert_eq!(store.persisted.shell.active_session.as_ref(), Some(&session_id));
				assert!(store.transcripts.is_empty());
			},
			"Capabilities" => {
				assert!(damage.contains(&Damage::Titlebar));
				assert!(damage.contains(&Damage::Composer(session_id.clone())));
			},
			"Interactions" => {
				assert!(damage.contains(&Damage::Composer(session_id.clone())));
			},
			"QueuedPrompts" => {
				assert!(damage.contains(&Damage::Composer(session_id.clone())));
				assert_eq!(
					store
						.queued
						.get(&session_id)
						.map(|held| held.in_delivery_order().collect::<Vec<_>>()),
					Some(vec!["check the tests too", "then write the changelog"]),
					"the section's two queues reach the store in delivery order"
				);
			},
			"Goal" => {
				assert!(damage.contains(&Damage::Composer(session_id.clone())));
				assert_eq!(
					store.goals.get(&session_id).map(|g| g.objective.as_str()),
					Some("Ship the desktop parity work"),
					"goal reaches store"
				);
			},
			"Settings" | "Diagnostics" | "Models" | "Providers" | "AuthFlow" | "Mcp" | "Agents"
			| "AgentComms" | "Share" | "Profiles" | "Themes" | "Keybindings" | "Commands" => {
				assert!(damage.contains(&Damage::Palette), "{name} must emit Damage::Palette");
			},
			"Changes" => {
				assert!(
					damage.contains(&Damage::RightPanelTab(session_id.clone(), "changes".to_string()))
				);
			},
			"FileTree" => {
				assert!(
					damage.contains(&Damage::RightPanelTab(session_id.clone(), "filetree".to_string()))
				);
			},
			"FileContent" => {
				assert!(
					damage
						.contains(&Damage::RightPanelTab(session_id.clone(), "filecontent".to_string()))
				);
			},
			"SearchResults" => {
				assert!(
					damage.contains(&Damage::RightPanelTab(
						session_id.clone(),
						"searchresults".to_string()
					))
				);
			},
			// The matches a content search found and the prompts a history
			// lookup found are rows of the palette that asked for them, which
			// floats over the whole window.
			"ContentMatches" | "PromptHistory" => {
				assert!(damage.contains(&Damage::FullWindow));
			},
			"Terminals" => {
				assert!(damage.contains(&Damage::TerminalDrawerChrome(session_id.clone())));
			},
			"TerminalOutput" => {
				assert!(
					damage.contains(&Damage::TerminalOutput(session_id.clone(), "term-1".to_string()))
				);
			},
			"Processes" | "ProcessLogs" => {
				assert!(damage.contains(&Damage::ProcessList(session_id.clone())));
			},
			"Usage" => {
				assert!(
					damage.contains(&Damage::RightPanelTab(session_id.clone(), "usage".to_string()))
				);
			},
			"ContextBreakdown" => {
				assert!(damage.contains(&Damage::RightPanelTab(
					session_id.clone(),
					"contextbreakdown".to_string()
				)));
			},
			"Export" => {
				assert!(
					damage.contains(&Damage::RightPanelTab(session_id.clone(), "export".to_string()))
				);
			},
			// The freeze strip is a band above the columns, so it moves every
			// region under it rather than repainting one of them.
			"AgentPause" => {
				assert!(damage.contains(&Damage::FullWindow));
			},
			// The console is drawn over the session it belongs to, so opening or
			// closing it relays the window rather than one band of it.
			"AutoswarmConsole" => {
				assert!(damage.contains(&Damage::FullWindow));
			},
			// The microphone belongs to the window rather than to one session, so
			// the chip redraws in the composer of whichever session is active, and
			// a waiting command's control redraws the composer of the session it
			// runs in.
			"Dictation" | "ForegroundCommand" => {
				assert!(damage.contains(&Damage::Composer(session_id.clone())));
			},
			other => panic!("Unhandled snapshot section in damage test: {other}"),
		}

		// Case B: No active session present for session-dependent chrome sections
		let mut no_session_store = Store::new();
		let damage_no_session = reduce(&mut no_session_store, HostEvent::Snapshot(section.clone()));

		match name {
			"Changes" | "FileTree" | "FileContent" | "SearchResults" | "Terminals"
			| "TerminalOutput" | "Processes" | "ProcessLogs" | "Dictation" => {
				assert!(
					damage_no_session.contains(&Damage::FullWindow),
					"{name} without active session must fallback to Damage::FullWindow"
				);
			},
			_ => {},
		}
	}

	assert_eq!(
		covered_sections.len(),
		ALL_SECTION_NAMES.len(),
		"Every section in ALL_SECTION_NAMES must be covered by damage test sweep"
	);
	for name in ALL_SECTION_NAMES {
		assert!(covered_sections.contains(name), "Section '{name}' missing from damage test sweep");
	}
}

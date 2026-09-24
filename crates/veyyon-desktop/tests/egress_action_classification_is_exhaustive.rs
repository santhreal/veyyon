use std::collections::HashSet;

use veyyon_desktop::{ActionClassification, classify_action};
use veyyon_desktop_model::HostActionKind;

#[test]
fn all_actions_are_classified_and_ephemeral_set_is_pinned_by_exact_equality() {
	assert_eq!(HostActionKind::ALL.len(), 94, "HostActionKind::ALL must contain exactly 94 actions");

	let mut ephemeral_actions = HashSet::new();
	let mut mutation_actions = HashSet::new();

	for kind in HostActionKind::ALL {
		match classify_action(kind) {
			ActionClassification::Ephemeral => {
				assert!(ephemeral_actions.insert(kind), "duplicate action in sweep: {kind:?}");
			},
			ActionClassification::Mutation => {
				assert!(mutation_actions.insert(kind), "duplicate action in sweep: {kind:?}");
			},
		}
	}

	assert_eq!(ephemeral_actions.len() + mutation_actions.len(), 94);

	// Pinned exact set of 25 ephemeral read-only actions (§8.13). A share read
	// again is one of them, and so is a profile listing: each asks the host for
	// what it holds now and alters nothing, so a full buffer drops it rather
	// than blocking a press.
	let expected_ephemeral: HashSet<HostActionKind> = [
		HostActionKind::ListSessions,
		HostActionKind::SearchSessions,
		HostActionKind::PreviewSessionTranscript,
		HostActionKind::LoadTranscript,
		HostActionKind::LoadFileTree,
		HostActionKind::ReadFile,
		HostActionKind::SearchFiles,
		HostActionKind::SearchContent,
		HostActionKind::SearchPromptHistory,
		HostActionKind::RefreshChanges,
		HostActionKind::RefreshProfiles,
		HostActionKind::RefreshProcesses,
		HostActionKind::ProcessLogs,
		HostActionKind::RefreshModels,
		HostActionKind::RefreshProviders,
		HostActionKind::RefreshMcp,
		HostActionKind::LoadSettings,
		HostActionKind::LoadThemes,
		HostActionKind::LoadKeybindings,
		HostActionKind::RefreshDiagnostics,
		HostActionKind::RefreshAgents,
		HostActionKind::GetUsage,
		HostActionKind::GetContextBreakdown,
		HostActionKind::RefreshShare,
		HostActionKind::ListCommands,
	]
	.into_iter()
	.collect();

	assert_eq!(
		ephemeral_actions, expected_ephemeral,
		"ephemeral action set must match exact pinned definition; any change must be recorded"
	);
	assert_eq!(ephemeral_actions.len(), 25);
}

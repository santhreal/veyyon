//! Dynamic product replica palette sources.

use crate::{
	Store, UiCommand,
	model::{Availability, ContentBlock, RemoteData},
	navigation::{Overlay, Route},
	palette::types::{Group, Item, Results, SourceState},
};

pub(super) fn quick_open(store: &Store) -> Results {
	let candidates = [sessions(store), messages(store), files(store)];
	let mut groups = Vec::new();
	let mut state = SourceState::Empty;
	for candidate in candidates {
		groups.extend(candidate.groups);
		state = merge_state(state, candidate.state);
	}
	Results { groups, state }
}

pub(super) fn sessions(store: &Store) -> Results {
	remote_results(
		&store.replica.sessions.sessions,
		|versioned| {
			versioned
				.value
				.iter()
				.map(|session| Item {
					id:              format!("session:{}", session.id),
					title:           session
						.title
						.clone()
						.unwrap_or_else(|| session.path.clone()),
					detail:          Some(session.cwd.clone()),
					disabled_reason: disconnected(store),
					current:         store.frontend.selected_session.as_ref() == Some(&session.id),
					commands:        vec![
						UiCommand::CloseTopOverlay,
						UiCommand::OpenSession(session.id.clone()),
					],
				})
				.collect()
		},
		"Sessions",
		"sessions",
	)
}

pub(super) fn messages(store: &Store) -> Results {
	remote_results(
		&store.replica.transcript,
		|versioned| {
			versioned
				.value
				.iter()
				.filter_map(|entry| {
					let text = entry.content.iter().find_map(|block| match block {
						ContentBlock::Text { text } if !text.trim().is_empty() => Some(text.clone()),
						_ => None,
					})?;
					Some(Item {
						id:              format!("message:{}", entry.id),
						title:           text.lines().next().unwrap_or_default().to_owned(),
						detail:          None,
						disabled_reason: None,
						current:         store.frontend.selected_entry.as_ref() == Some(&entry.id),
						commands:        vec![
							UiCommand::CloseTopOverlay,
							UiCommand::SelectEntry(entry.id.clone()),
						],
					})
				})
				.collect()
		},
		"Messages",
		"messages",
	)
}

pub(super) fn files(store: &Store) -> Results {
	remote_results(
		&store.replica.files,
		|versioned| {
			versioned
				.value
				.nodes
				.iter()
				.map(|node| Item {
					id:              format!("file:{}", node.id),
					title:           node.name.clone(),
					detail:          Some(node.path.clone()),
					disabled_reason: None,
					current:         store.frontend.selected_file.as_ref() == Some(&node.id),
					commands:        vec![
						UiCommand::CloseTopOverlay,
						UiCommand::SelectFile(node.id.clone()),
						UiCommand::Navigate(Route::Files),
					],
				})
				.collect()
		},
		"Files",
		"files",
	)
}

pub(super) fn models(store: &Store) -> Results {
	let Some(catalog) = store.replica.models.readable() else {
		return state_only(&store.replica.models);
	};
	let mut result = remote_results(
		&catalog.value.models,
		|models| {
			models
				.iter()
				.map(|model| Item {
					id:              format!("model:{}:{}", model.provider, model.id),
					title:           model.name.clone(),
					detail:          Some(model.provider.to_string()),
					disabled_reason: match &model.availability {
						Availability::Available => disconnected(store),
						Availability::Unavailable { reason } => Some(reason.clone()),
					},
					current:         catalog.value.selected.as_ref()
						== Some(&(model.provider.clone(), model.id.clone())),
					commands:        vec![UiCommand::CloseTopOverlay, UiCommand::SelectModel {
						provider: model.provider.clone(),
						model:    model.id.clone(),
					}],
				})
				.collect()
		},
		"Models",
		"models",
	);
	inherit_outer_state(&mut result.state, &store.replica.models);
	result
}

pub(super) fn providers(store: &Store) -> Results {
	remote_results(
		&store.replica.providers,
		|versioned| {
			versioned
				.value
				.iter()
				.map(|provider| Item {
					id:              format!("provider:{}", provider.id),
					title:           provider.name.clone(),
					detail:          provider.status.clone(),
					disabled_reason: provider
						.error
						.clone()
						.or_else(|| (!provider.available).then(|| "Provider unavailable".to_owned()))
						.or_else(|| disconnected(store)),
					current:         provider.authenticated,
					commands:        vec![
						UiCommand::CloseTopOverlay,
						UiCommand::StartProviderAuth(provider.id.clone()),
						UiCommand::OpenOverlay(Overlay::ProviderAuth { provider: provider.id.clone() }),
					],
				})
				.collect()
		},
		"Providers",
		"providers",
	)
}

pub(super) fn agents(store: &Store) -> Results {
	let Some(roster) = store.replica.agents.readable() else {
		return state_only(&store.replica.agents);
	};
	let mut result = remote_results(
		&roster.value.agents,
		|agents| {
			agents
				.iter()
				.map(|agent| Item {
					id:              format!("agent:{}", agent.id),
					title:           agent.display_name.clone(),
					detail:          agent
						.activity
						.clone()
						.or_else(|| Some(format!("{:?}", agent.status))),
					disabled_reason: None,
					current:         store.frontend.selected_agent.as_ref() == Some(&agent.id),
					commands:        vec![
						UiCommand::CloseTopOverlay,
						UiCommand::SelectAgent(agent.id.clone()),
						UiCommand::Navigate(Route::Agents),
					],
				})
				.collect()
		},
		"Agents",
		"agents",
	);
	inherit_outer_state(&mut result.state, &store.replica.agents);
	result
}

fn remote_results<T>(
	remote: &RemoteData<T>,
	build: impl FnOnce(&T) -> Vec<Item>,
	label: &'static str,
	id: &'static str,
) -> Results {
	let items = remote.readable().map(build).unwrap_or_default();
	let state = source_state(remote, items.is_empty());
	Results {
		groups: (!items.is_empty())
			.then_some(Group { id, label, items })
			.into_iter()
			.collect(),
		state,
	}
}

fn state_only<T>(remote: &RemoteData<T>) -> Results {
	Results { groups: Vec::new(), state: source_state(remote, true) }
}

fn source_state<T>(remote: &RemoteData<T>, empty: bool) -> SourceState {
	match remote {
		RemoteData::Unrequested | RemoteData::Loading { .. } => SourceState::Loading,
		RemoteData::Empty => SourceState::Empty,
		RemoteData::Ready(_) if empty => SourceState::Empty,
		RemoteData::Ready(_) => SourceState::Ready,
		RemoteData::Stale { reason, .. } => SourceState::Stale(format!("{reason:?}")),
		RemoteData::Error { message, retryable, .. } => {
			SourceState::Error { message: message.clone(), retryable: *retryable }
		},
	}
}

fn inherit_outer_state<T>(state: &mut SourceState, outer: &RemoteData<T>) {
	match outer {
		RemoteData::Stale { reason, .. } => *state = SourceState::Stale(format!("{reason:?}")),
		RemoteData::Error { message, retryable, .. } => {
			*state = SourceState::Error { message: message.clone(), retryable: *retryable };
		},
		_ => {},
	}
}

fn merge_state(left: SourceState, right: SourceState) -> SourceState {
	use SourceState::{Empty, Error, Loading, Ready, Stale, Unavailable};
	match (left, right) {
		(Error { message, retryable }, _) | (_, Error { message, retryable }) => {
			Error { message, retryable }
		},
		(Stale(reason), _) | (_, Stale(reason)) => Stale(reason),
		(Ready, _) | (_, Ready) => Ready,
		(Loading, _) | (_, Loading) => Loading,
		(Unavailable(reason), _) | (_, Unavailable(reason)) => Unavailable(reason),
		(Empty, Empty) => Empty,
	}
}

fn disconnected(store: &Store) -> Option<String> {
	(!store.connection.is_connected()).then(|| "Reconnect to make this change".to_owned())
}

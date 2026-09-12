//! Window intent dispatch with host-confirmed navigation.

use std::{cell::RefCell, rc::Rc};

use veyyon_desktop::{
	actions_for, current_timestamp_ms, launch::WindowSlot, project, project_controls, record_sent,
	resize_terminals, surface_for_action,
};
use veyyon_desktop_model::{HostAction, RequestId, SessionId};
use veyyon_desktop_surface::{Intent, ShellView};
use veyyon_gpui::{App, WindowHandle};

use super::{Host, lifecycle};

pub(super) fn observe(
	host: Rc<RefCell<Host>>,
	window: WindowHandle<ShellView>,
	slot: WindowSlot,
	cx: &mut App,
) {
	let Ok(entity) = window.entity(cx) else {
		return;
	};
	cx.observe(&entity, move |entity, cx| {
		let intents = entity.update(cx, |view, _| view.drain_intents());
		if intents.is_empty() {
			return;
		}
		let mut host = host.borrow_mut();
		let host = &mut *host;
		let now_ms = current_timestamp_ms();
		let navigation = intents.iter().any(Intent::changes_navigation);
		if navigation {
			let _ = window.update(cx, |view, window, cx| host.keep(view, window, now_ms, cx));
		}
		for intent in &intents {
			if matches!(intent, Intent::Send { .. }) && host.navigation.is_pending() {
				entity.update(cx, |view, cx| {
					view.set_composer_notice(
						"Wait for the session to finish opening before submitting".into(),
						cx,
					);
				});
				continue;
			}
			if intent.changes_navigation()
				&& let Some(reason) = entity.read(cx).navigation_rejection()
			{
				entity.update(cx, |view, cx| view.set_notice(Some(reason.into()), cx));
				continue;
			}
			if intent.changes_navigation() && host.navigation.is_pending() {
				entity.update(cx, |view, cx| {
					view.set_notice(
						Some(
							"A session is still opening. Wait for it to finish before switching.".into(),
						),
						cx,
					);
				});
				continue;
			}
			let previous = intent
				.changes_navigation()
				.then(|| host.store.persisted.shell.navigation.clone());
			let actions = actions_for(intent, &host.index, &mut host.store);
			let candidate = if actions
				.iter()
				.any(|action| matches!(action, HostAction::OpenSession { .. }))
			{
				previous.map(|previous| {
					std::mem::replace(&mut host.store.persisted.shell.navigation, previous)
				})
			} else {
				None
			};
			let mut candidate = candidate;
			let active = Some(SessionId::from(entity.read(cx).state().current_id.to_string()));
			for action in actions {
				let surface = surface_for_action(intent, &action, active.as_ref());
				let request = host.link.send(action.clone());
				if matches!(
					&action,
					HostAction::OpenSession { .. }
						| HostAction::LoadTranscript { .. }
						| HostAction::CreateSession { .. }
						| HostAction::BranchSession { .. }
				) {
					let mut next = candidate
						.take()
						.unwrap_or_else(|| host.store.persisted.shell.navigation.clone());
					if let HostAction::OpenSession { session }
					| HostAction::LoadTranscript { session, .. } = &action
					{
						next.opened(session.clone());
					}
					host.navigation.begin(request, next);
				}
				host.history.sent(request, &action);
				record_sent(&mut host.store, &mut host.registry, request, &action, surface, now_ms);
				entity.update(cx, |view, _| view.track_submission(request, intent));
			}
		}
		if let Some(intent) = intents
			.iter()
			.find(|intent| matches!(intent, Intent::CloseWindow | Intent::Quit))
		{
			lifecycle::close(host, intent, &window, &slot, now_ms, cx);
			return;
		}
		let resized = resize_terminals(&mut host.terminals, &intents);
		let _ = window.update(cx, |view, window, cx| {
			if resized
				|| navigation
				|| intents
					.iter()
					.any(|intent| intent.moves_partition() || matches!(intent, Intent::Navigate(_)))
			{
				project(&host.store, &mut host.index, &host.terminals, now_ms, view.state_mut());
			}
			view.reconcile_reviews();
			if navigation {
				host.keep(view, window, now_ms, cx);
			}
			project_controls(&host.store, &host.registry, &host.index, view.state_mut());
			cx.notify();
		});
	})
	.detach();
}

pub(super) fn finish_navigation(host: &mut Host, request: RequestId, succeeded: bool) {
	host
		.navigation
		.finish(request, succeeded, &mut host.store.persisted.shell.navigation);
}

pub(super) fn expire_navigation(host: &mut Host, now_ms: u64) -> bool {
	host.navigation.expire(&mut host.registry, now_ms)
}

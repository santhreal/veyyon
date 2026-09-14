//! WHY: rejected, unrelated and late acknowledgements must not install a
//! candidate tab layout. These tests exercise the production transaction and
//! registry; the separate driven-window suite covers draft retention and
//! projection, not transport delivery.

use veyyon_desktop::project::navigation_request::NavigationRequest;
use veyyon_desktop_model::{
	HostActionKind, RequestId, RequestRegistry, SurfaceId, persistence::NavigationStore,
};

fn layouts() -> (NavigationStore, NavigationStore) {
	let mut original = NavigationStore::default();
	original.opened("first".into());
	let mut candidate = original.clone();
	let other = candidate.create("Review").expect("distinct named space");
	assert!(candidate.switch(other));
	candidate.active_mut().queue_collapsed = true;
	candidate.opened("second".into());
	(original, candidate)
}

#[test]
fn only_the_matching_success_commits_the_entire_candidate_layout() {
	for succeeded in [false, true] {
		let (original, candidate) = layouts();
		let mut committed = original.clone();
		let mut transaction = NavigationRequest::default();
		assert!(transaction.begin(RequestId(7), candidate.clone()));
		assert!(!transaction.begin(RequestId(8), NavigationStore::default()));
		for unrelated in [RequestId(6), RequestId(8)] {
			assert!(!transaction.finish(unrelated, succeeded, &mut committed));
			assert!(transaction.is_pending());
			assert_eq!(committed, original);
		}
		assert!(transaction.finish(RequestId(7), succeeded, &mut committed));
		assert!(!transaction.is_pending());
		assert_eq!(committed, if succeeded { candidate } else { original });
		let completed = committed.clone();
		assert!(!transaction.finish(RequestId(7), !succeeded, &mut committed));
		assert_eq!(committed, completed);
	}
}

#[test]
fn expiration_releases_the_request_at_the_registry_deadline_without_committing() {
	for (now, expires) in [(9, false), (39, false), (40, false), (41, true), (u64::MAX, true)] {
		let (original, candidate) = layouts();
		let mut committed = original.clone();
		let mut transaction = NavigationRequest::default();
		let mut registry = RequestRegistry::new();
		registry.register(
			RequestId(7),
			HostActionKind::OpenSession,
			SurfaceId::GlobalTitlebarLine,
			10,
			30,
		);
		assert!(transaction.begin(RequestId(7), candidate));
		assert_eq!(transaction.expire(&mut registry, now), expires);
		assert_eq!(transaction.is_pending(), !expires);
		assert_eq!(registry.get(&RequestId(7)).is_none(), expires);
		if expires {
			assert!(!transaction.finish(RequestId(7), true, &mut committed));
			assert_eq!(committed, original);
		}
	}
}

#[test]
fn disconnect_or_registry_removal_discards_the_candidate_and_allows_retry() {
	for registry_removed in [false, true] {
		let (original, candidate) = layouts();
		let mut committed = original.clone();
		let mut transaction = NavigationRequest::default();
		assert!(transaction.begin(RequestId(7), candidate.clone()));
		if registry_removed {
			assert!(transaction.expire(&mut RequestRegistry::new(), 10));
		} else {
			let mut registry = RequestRegistry::new();
			registry.register(
				RequestId(7),
				HostActionKind::OpenSession,
				SurfaceId::GlobalTitlebarLine,
				0,
				30,
			);
			registry.register(
				RequestId(9),
				HostActionKind::RefreshModels,
				SurfaceId::GlobalTitlebarLine,
				0,
				30,
			);
			transaction.cancel(&mut registry);
			assert!(registry.get(&RequestId(7)).is_none());
			assert!(registry.get(&RequestId(9)).is_some(), "an unrelated request was cancelled");
		}
		assert!(!transaction.is_pending());
		assert!(!transaction.finish(RequestId(7), true, &mut committed));
		assert_eq!(committed, original);
		assert!(transaction.begin(RequestId(8), candidate.clone()));
		assert!(transaction.finish(RequestId(8), true, &mut committed));
		assert_eq!(committed, candidate);
	}
}

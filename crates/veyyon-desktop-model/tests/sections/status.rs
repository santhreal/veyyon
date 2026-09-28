//! The status-line sections: the machine the host runs on and, per session,
//! the checkout, the pace, the serving login and its quota.

use veyyon_desktop_model::{
	SessionId, SnapshotSection,
	domain::{
		CheckoutView, HostView, PaceView, PullRequestView, QuotaView, QuotaWindowView,
		ServingAccountView,
	},
};

pub fn host(hostname: &str) -> SnapshotSection {
	SnapshotSection::Host(HostView { hostname: hostname.into() })
}

/// A checkout on `branch`, with a pull request open when `pull_request` names
/// its number, or no checkout at all when `branch` is `None`.
pub fn checkout(session: &str, branch: Option<&str>, pull_request: Option<u64>) -> SnapshotSection {
	SnapshotSection::Checkout {
		session:  SessionId::from(session),
		checkout: branch.map(|branch| CheckoutView {
			branch:       branch.into(),
			dirty:        pull_request.is_some(),
			pull_request: pull_request.map(|number| PullRequestView {
				number,
				url: format!("https://github.com/example/repo/pull/{number}"),
			}),
		}),
	}
}

pub fn pace(session: &str, worked_ms: u64, working_since_ms: Option<u64>) -> SnapshotSection {
	SnapshotSection::Pace {
		session: SessionId::from(session),
		pace:    PaceView {
			worked_ms,
			working_since_ms,
			tokens_per_second_tenths: working_since_ms.map(|_| 423),
		},
	}
}

pub fn serving(session: &str, label: Option<&str>) -> SnapshotSection {
	SnapshotSection::ServingAccount {
		session: SessionId::from(session),
		account: label.map(|label| ServingAccountView {
			provider:  "anthropic".into(),
			label:     label.into(),
			logins:    2,
			predicted: false,
		}),
	}
}

pub fn quota(session: &str, five_hour_permille: Option<u32>) -> SnapshotSection {
	SnapshotSection::Quota {
		session: SessionId::from(session),
		quota:   five_hour_permille.map(|used_permille| QuotaView {
			tier:      Some("max".into()),
			five_hour: Some(QuotaWindowView { used_permille, resets_at_ms: Some(1_700_000_000_000) }),
			seven_day: None,
		}),
	}
}

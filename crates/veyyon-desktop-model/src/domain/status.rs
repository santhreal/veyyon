//! The terminal's status-line facts about a session beyond its transcript.
//!
//! These are the machine the host runs on, the checkout the session works in,
//! how long the agent has worked and how fast it replies, the stored login
//! serving the session and that login's subscription quota.
//!
//! Every value is the host's. A duration the window draws while it runs is
//! sent as the moment it started plus what came before it, so the label is
//! computed at render and no frame is owed per second.

use serde::{Deserialize, Serialize};

/// The machine the host process runs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct HostView {
	/// The name the operating system reports for the machine, domain
	/// included. The terminal draws the label before the first `.`.
	pub hostname: String,
}

/// A pull request opened from the checked-out branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct PullRequestView {
	/// The pull request's number in its repository.
	pub number: u64,
	/// The pull request's web address.
	pub url:    String,
}

/// The branch a session's checkout is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct CheckoutView {
	/// The branch name, or the short label of a detached HEAD or of an
	/// operation in progress, spelled as the terminal spells it.
	pub branch:       String,
	/// Whether the tree holds staged, unstaged or untracked changes.
	pub dirty:        bool,
	/// The pull request `gh` reports for the branch, absent on the default
	/// branch, without a GitHub remote, or while none is open.
	pub pull_request: Option<PullRequestView>,
}

/// How long the agent has worked in a session and how fast its reply streams.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct PaceView {
	/// Milliseconds of every finished working window, summed. Idle time
	/// between turns never counts.
	pub worked_ms:                u64,
	/// Epoch milliseconds the running working window opened, absent while
	/// the agent is idle.
	pub working_since_ms:         Option<u64>,
	/// The latest reply's output rate in tenths of a token per second (`423`
	/// is 42.3 tok/s), absent before a reply long enough to rate.
	pub tokens_per_second_tenths: Option<u32>,
}

impl PaceView {
	/// The time the agent has worked as of `now_ms`.
	///
	/// The finished windows plus the running one. A clock that reads earlier
	/// than the window's start adds nothing rather than subtracting.
	#[must_use]
	pub const fn worked_ms_at(&self, now_ms: u64) -> u64 {
		match self.working_since_ms {
			Some(since) => self.worked_ms.saturating_add(now_ms.saturating_sub(since)),
			None => self.worked_ms,
		}
	}
}

/// The stored login serving a session's provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ServingAccountView {
	/// The provider the session's model runs on.
	pub provider:  String,
	/// The login's display label: its account name, email or identifier.
	pub label:     String,
	/// Logins stored for the provider. The terminal states the account only
	/// when this is two or more, since one login is not in question.
	pub logins:    u32,
	/// True before the session's first request, when routing has predicted
	/// the login that will serve rather than confirmed one.
	pub predicted: bool,
}

/// One subscription quota window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QuotaWindowView {
	/// Share of the window used, in tenths of a percent (`805` is 80.5%).
	pub used_permille: u32,
	/// Epoch milliseconds the window resets, when the provider reports it.
	pub resets_at_ms:  Option<u64>,
}

/// The subscription quota of the login serving a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QuotaView {
	/// The plan tier the provider names, when it names one.
	pub tier:      Option<String>,
	/// The rolling five-hour window.
	pub five_hour: Option<QuotaWindowView>,
	/// The rolling seven-day window.
	pub seven_day: Option<QuotaWindowView>,
}

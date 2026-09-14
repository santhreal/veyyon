use std::time::Duration;

use thiserror::Error;

/// Initial reconnection delay: 500 ms (§8.13).
pub const INITIAL_DELAY_MS: u64 = 500;

/// Exponential backoff multiplier: 1.5 (§8.13).
pub const MULTIPLIER: f64 = 1.5;

/// Maximum single-attempt reconnection delay: 15,000 ms (§8.13).
pub const MAX_DELAY_MS: u64 = 15_000;

/// Uniform random variance band: ±10% (§8.13).
pub const JITTER_PCT: f64 = 0.10;

/// Maximum number of reconnection attempts before fatal termination: 10
/// (§8.13).
pub const MAX_ATTEMPTS: u32 = 10;

/// Maximum total elapsed disconnection window before fatal termination: 120,000
/// ms (§8.13).
pub const MAX_ELAPSED_MS: u64 = 120_000;

/// Canonical fatal error message when retry ceiling or timeout window is
/// exceeded (§8.13).
pub const FATAL_MESSAGE: &str = "Connection failed after 10 retry attempts (120s elapsed)";

/// Errors encountered during reconnection scheduling.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ReconnectError {
	#[error("{0}")]
	Fatal(String),
}

/// Computes nominal base delay in milliseconds for a given 1-indexed attempt
/// number.
///
/// Formula: `min(MAX_DELAY_MS, INITIAL_DELAY_MS * (MULTIPLIER ^ (attempt -
/// 1)))`.
#[must_use]
pub fn base_delay_ms(attempt: u32) -> u64 {
	if attempt == 0 {
		return INITIAL_DELAY_MS;
	}
	let exp = i32::try_from(attempt.saturating_sub(1)).unwrap_or(0);
	let nominal = (INITIAL_DELAY_MS as f64) * MULTIPLIER.powi(exp);
	let capped = nominal.min(MAX_DELAY_MS as f64);
	capped.round() as u64
}

/// Computes minimum bound of the jitter band for attempt `n`.
#[must_use]
pub fn min_jitter_delay_ms(attempt: u32) -> u64 {
	let base = base_delay_ms(attempt) as f64;
	let min_val = base * (1.0 - JITTER_PCT);
	min_val.round() as u64
}

/// Computes maximum bound of the jitter band for attempt `n`.
#[must_use]
pub fn max_jitter_delay_ms(attempt: u32) -> u64 {
	let base = base_delay_ms(attempt) as f64;
	let max_val = base * (1.0 + JITTER_PCT);
	max_val.round() as u64
}

/// Pure calculation of reconnection delay with an explicit jitter factor in
/// `[-0.10, 0.10]`.
#[must_use]
pub fn delay_with_jitter_factor(attempt: u32, jitter_factor: f64) -> u64 {
	let base = base_delay_ms(attempt) as f64;
	let clamped_factor = jitter_factor.clamp(-JITTER_PCT, JITTER_PCT);
	let with_jitter = base * (1.0 + clamped_factor);
	with_jitter.max(0.0).round() as u64
}

/// Trait providing reproducible uniform jitter factors in `[-JITTER_PCT,
/// JITTER_PCT]`.
pub trait JitterSource: Send + Sync {
	/// Returns a jitter factor scalar between `-0.10` and `+0.10`.
	fn jitter_factor(&mut self) -> f64;
}

/// Deterministic jitter source returning a constant factor (useful for unit
/// tests).
#[derive(Debug, Clone, Default)]
pub struct DeterministicJitter(pub f64);

impl JitterSource for DeterministicJitter {
	fn jitter_factor(&mut self) -> f64 {
		self.0
	}
}

/// Zero-jitter source returning `0.0` (pure nominal exponential curve).
#[derive(Debug, Clone, Default)]
pub struct ZeroJitter;

impl JitterSource for ZeroJitter {
	fn jitter_factor(&mut self) -> f64 {
		0.0
	}
}

/// Seeded pseudo-random generator producing deterministic uniform jitter
/// without external deps.
#[derive(Debug, Clone)]
pub struct SeededJitter {
	state: u64,
}

impl SeededJitter {
	/// Initializes a new seeded jitter generator.
	#[must_use]
	pub const fn new(seed: u64) -> Self {
		Self {
			state: if seed == 0 {
				0x5eed_cafe_beef_1234
			} else {
				seed
			},
		}
	}

	const fn next_u32(&mut self) -> u32 {
		let mut x = self.state;
		x ^= x >> 12;
		x ^= x << 25;
		x ^= x >> 27;
		self.state = x;
		((x.wrapping_mul(0x2545_f491_4f6c_dd1d)) >> 32) as u32
	}
}

impl Default for SeededJitter {
	fn default() -> Self {
		Self::new(0x1337_cafe_d00d_feed)
	}
}

impl JitterSource for SeededJitter {
	fn jitter_factor(&mut self) -> f64 {
		let unit = (f64::from(self.next_u32())) / (f64::from(u32::MAX));
		unit.mul_add(JITTER_PCT * 2.0, -JITTER_PCT)
	}
}

/// Stateful reconnection policy enforcing bounded attempts and total elapsed
/// disconnection bounds.
#[derive(Debug, Clone)]
pub struct ReconnectPolicy<J: JitterSource = SeededJitter> {
	jitter:           J,
	attempt:          u32,
	total_elapsed_ms: u64,
}

impl Default for ReconnectPolicy<SeededJitter> {
	fn default() -> Self {
		Self::new(SeededJitter::default())
	}
}

impl<J: JitterSource> ReconnectPolicy<J> {
	/// Constructs a new reconnection policy with an injected jitter source.
	pub const fn new(jitter: J) -> Self {
		Self { jitter, attempt: 0, total_elapsed_ms: 0 }
	}

	/// Current 1-indexed attempt number reached.
	#[must_use]
	pub const fn attempt(&self) -> u32 {
		self.attempt
	}

	/// Cumulative elapsed backoff time in milliseconds.
	#[must_use]
	pub const fn total_elapsed_ms(&self) -> u64 {
		self.total_elapsed_ms
	}

	/// Resets attempt count and cumulative elapsed time upon successful
	/// connection.
	pub const fn reset(&mut self) {
		self.attempt = 0;
		self.total_elapsed_ms = 0;
	}

	/// Computes the next backoff delay duration, or returns
	/// [`ReconnectError::Fatal`] if bounded retry ceilings (10 attempts or 120s
	/// total elapsed) are exceeded.
	pub fn next_delay(&mut self) -> Result<Duration, ReconnectError> {
		if self.attempt >= MAX_ATTEMPTS || self.total_elapsed_ms >= MAX_ELAPSED_MS {
			return Err(ReconnectError::Fatal(FATAL_MESSAGE.to_string()));
		}

		self.attempt = self.attempt.saturating_add(1);
		let factor = self.jitter.jitter_factor();
		let delay = delay_with_jitter_factor(self.attempt, factor);

		let next_total = self.total_elapsed_ms.saturating_add(delay);
		if next_total > MAX_ELAPSED_MS {
			let remaining = MAX_ELAPSED_MS.saturating_sub(self.total_elapsed_ms);
			self.total_elapsed_ms = MAX_ELAPSED_MS;
			if remaining == 0 {
				return Err(ReconnectError::Fatal(FATAL_MESSAGE.to_string()));
			}
			return Ok(Duration::from_millis(remaining));
		}

		self.total_elapsed_ms = next_total;
		Ok(Duration::from_millis(delay))
	}
}

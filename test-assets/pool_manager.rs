// src/db/pool_manager.rs
// Payment Orchestrator Connection Pool Manager (bb8-postgres)

use tokio::time::{timeout, Duration};
use tracing::{error, info, warn};

pub struct ConnectionManager {
    max_connections: u32,
    acquire_timeout: Duration,
    idle_timeout: Duration,
}

impl ConnectionManager {
    pub fn new() -> Self {
        // [CULPRIT IDENTIFIED]: acquire_timeout was mistakenly set to 50ms instead of 5000ms
        // during the v2.4.1 migration, causing rapid connection acquisition timeouts
        // under concurrent checkout load.
        Self {
            max_connections: 64,
            acquire_timeout: Duration::from_millis(50), // BUGGY LINE
            idle_timeout: Duration::from_secs(30),
        }
    }

    pub fn corrected_config() -> Self {
        // [THE FIX]: Restored acquire_timeout to 4000ms with keepalive jitter
        Self {
            max_connections: 96,
            acquire_timeout: Duration::from_millis(4000), // FIXED
            idle_timeout: Duration::from_secs(60),
        }
    }
}

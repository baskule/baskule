// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Addresses assigned to interfaces in the supervisor's own network namespace.
//!
//! A `public_internet` endpoint admits any globally routable address. The
//! supervisor host itself may own such an address (for example a public IPv6
//! address on a host-networked supervisor), and services listening on it must
//! stay unreachable. This module answers "is this one of my own addresses?"
//! with a short-lived cache so the check stays cheap on the connect path.

use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const REFRESH_INTERVAL: Duration = Duration::from_secs(5);

static CACHE: Mutex<Option<(Instant, HashSet<IpAddr>)>> = Mutex::new(None);

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

#[cfg(target_os = "linux")]
fn read_interface_addresses() -> HashSet<IpAddr> {
    let mut addresses = HashSet::new();
    match nix::ifaddrs::getifaddrs() {
        Ok(interfaces) => {
            for interface in interfaces {
                let Some(address) = interface.address else {
                    continue;
                };
                if let Some(v4) = address.as_sockaddr_in() {
                    addresses.insert(IpAddr::V4(v4.ip()));
                } else if let Some(v6) = address.as_sockaddr_in6() {
                    addresses.insert(canonical(IpAddr::V6(v6.ip())));
                }
            }
        }
        Err(error) => {
            tracing::warn!(%error, "failed to enumerate local interface addresses");
        }
    }
    addresses
}

#[cfg(not(target_os = "linux"))]
fn read_interface_addresses() -> HashSet<IpAddr> {
    HashSet::new()
}

/// Returns `true` when `ip` is assigned to an interface in the supervisor's
/// network namespace. The interface list is refreshed at most every five
/// seconds.
pub(crate) fn is_local_interface_ip(ip: IpAddr) -> bool {
    let ip = canonical(ip);
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = Instant::now();
    let stale = cache
        .as_ref()
        .is_none_or(|(at, _)| now.duration_since(*at) >= REFRESH_INTERVAL);
    if stale {
        *cache = Some((now, read_interface_addresses()));
    }
    cache
        .as_ref()
        .is_some_and(|(_, addresses)| addresses.contains(&ip))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_a_local_interface_address() {
        assert!(is_local_interface_ip("127.0.0.1".parse().unwrap()));
        assert!(is_local_interface_ip("::ffff:127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn documentation_address_is_not_local() {
        assert!(!is_local_interface_ip("192.0.2.77".parse().unwrap()));
    }
}

// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Shared networking utilities for `OpenShell` crates.
//!
//! The IP-classification helpers enforce the always-blocked IP invariant
//! (loopback, link-local, unspecified) and the broader internal-IP
//! classification (adds RFC 1918 and ULA).  They are used by:
//! - The sandbox proxy for runtime SSRF enforcement
//! - The mechanistic mapper for proposal filtering
//! - The gateway server for defense-in-depth validation on approval
//!
//! The socket tuning helpers ([`set_tcp_nodelay_best_effort`],
//! [`connect_tcp_nodelay_best_effort`]) help avoid the known latency
//! imposed by conflict between Nagle's algorithm and delayed ACK behaviors.
//!

// Modified for Baskule: generic shared-address examples in address-classification tests.

use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use tokio::net::TcpStream;

/// Check if a hostname is a known cloud metadata hostname that resolves to an
/// always-blocked metadata service.
///
/// This is intentionally a static name check. Do not perform DNS resolution in
/// policy validation or proposal generation paths.
pub fn is_known_metadata_hostname(host: &str) -> bool {
    let normalized = host.trim().trim_end_matches('.').to_ascii_lowercase();
    matches!(normalized.as_str(), "metadata.google.internal")
}

/// Check if an IP address is link-local.
///
/// Covers IPv4 `169.254.0.0/16`, IPv6 `fe80::/10`, and IPv4-mapped IPv6
/// addresses whose embedded IPv4 address is link-local (`::ffff:169.254.x.x`).
///
/// This is a point-check helper used to build the always-blocked and
/// trusted-gateway exemption predicates. For CIDR-range overlap checks see
/// [`is_always_blocked_net`].
pub fn is_link_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => {
            // fe80::/10 — IPv6 link-local
            if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            // ::ffff:169.254.x.x — IPv4-mapped link-local
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.is_link_local();
            }
            false
        }
    }
}

/// Check if an IP address is always blocked regardless of policy.
///
/// Loopback, link-local, and unspecified addresses are never allowed even when
/// an endpoint has `allowed_ips` configured. This prevents proxy bypass
/// (loopback) and cloud metadata SSRF (link-local 169.254.x.x).
pub fn is_always_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_link_local() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if is_link_local_ip(IpAddr::V6(v6)) {
                return true;
            }
            // Check IPv4-mapped IPv6 (::ffff:x.x.x.x)
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.is_loopback() || v4.is_unspecified();
            }
            false
        }
    }
}

/// Check if a CIDR network overlaps any always-blocked range.
///
/// Returns `true` if the network contains or overlaps loopback (`127.0.0.0/8`),
/// link-local (`169.254.0.0/16`), unspecified (`0.0.0.0`), or their IPv6
/// equivalents.  A CIDR like `0.0.0.0/0` is rejected because it contains
/// always-blocked addresses.
///
/// Used at policy load time and server-side approval to reject entries that
/// would be silently blocked at runtime by [`is_always_blocked_ip`].
pub fn is_always_blocked_net(net: IpNet) -> bool {
    match net {
        IpNet::V4(v4net) => {
            let network = v4net.network();
            let broadcast = v4net.broadcast();

            // Check if the range overlaps 127.0.0.0/8 (loopback)
            if broadcast >= Ipv4Addr::new(127, 0, 0, 0)
                && network <= Ipv4Addr::new(127, 255, 255, 255)
            {
                return true;
            }

            // Check if the range overlaps 169.254.0.0/16 (link-local)
            if broadcast >= Ipv4Addr::new(169, 254, 0, 0)
                && network <= Ipv4Addr::new(169, 254, 255, 255)
            {
                return true;
            }

            // Check if the range contains 0.0.0.0 (unspecified)
            if network == Ipv4Addr::UNSPECIFIED {
                return true;
            }

            false
        }
        IpNet::V6(v6net) => {
            // For IPv6, check the network address itself and representative
            // addresses within the range.
            let network = v6net.network();

            // ::1 (loopback)
            if v6net.contains(&Ipv6Addr::LOCALHOST) {
                return true;
            }

            // :: (unspecified)
            if v6net.contains(&Ipv6Addr::UNSPECIFIED) {
                return true;
            }

            // fe80::/10 (link-local) — check overlap
            if (network.segments()[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            // Also check if a broad prefix contains fe80::
            if v6net.contains(&Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0)) {
                return true;
            }

            // Check IPv4-mapped IPv6 addresses. The network-address check covers
            // ranges whose first address is already in a blocked range
            // (e.g. ::ffff:127.0.0.1/128, ::ffff:169.254.0.1/128). The
            // containment checks below catch broader prefixes that only reach
            // into a blocked range further in — e.g. ::ffff:168.0.0.0/103
            // has a public network address but spans ::ffff:169.254.0.0.
            if network
                .to_ipv4_mapped()
                .is_some_and(|v4| v4.is_loopback() || v4.is_link_local() || v4.is_unspecified())
            {
                return true;
            }
            if v6net.contains(&Ipv4Addr::LOCALHOST.to_ipv6_mapped())
                || v6net.contains(&Ipv4Addr::new(169, 254, 0, 0).to_ipv6_mapped())
                || v6net.contains(&Ipv4Addr::UNSPECIFIED.to_ipv6_mapped())
            {
                return true;
            }

            false
        }
    }
}

const RFC1918_10_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(10, 0, 0, 0), 8);
const RFC1918_172_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(172, 16, 0, 0), 12);
const RFC1918_192_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(192, 168, 0, 0), 16);
const CGNAT_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(100, 64, 0, 0), 10);
const IETF_PROTOCOL_ASSIGNMENTS_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 0, 0), 24);
const TEST_NET_1: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 2, 0), 24);
const BENCHMARKING_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(198, 18, 0, 0), 15);
const TEST_NET_2: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(198, 51, 100, 0), 24);
const TEST_NET_3: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(203, 0, 113, 0), 24);
const LIMITED_BROADCAST_NET: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::BROADCAST, 32);
const IPV6_ULA_NET: Ipv6Net = Ipv6Net::new_assert(Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7);

const NON_HARD_INTERNAL_V4_NETS: [Ipv4Net; 10] = [
    RFC1918_10_NET,
    RFC1918_172_NET,
    RFC1918_192_NET,
    CGNAT_NET,
    IETF_PROTOCOL_ASSIGNMENTS_NET,
    TEST_NET_1,
    BENCHMARKING_NET,
    TEST_NET_2,
    TEST_NET_3,
    LIMITED_BROADCAST_NET,
];

fn ipv4_nets_intersect(left: Ipv4Net, right: Ipv4Net) -> bool {
    left.network() <= right.broadcast() && right.network() <= left.broadcast()
}

fn ipv6_nets_intersect(left: Ipv6Net, right: Ipv6Net) -> bool {
    left.network() <= right.broadcast() && right.network() <= left.broadcast()
}

fn ipv4_net_to_mapped_ipv6(net: Ipv4Net) -> Ipv6Net {
    Ipv6Net::new_assert(net.network().to_ipv6_mapped(), 96_u8 + net.prefix_len())
}

/// Check if an IP address is internal (loopback, private RFC 1918, link-local,
/// or unspecified).
///
/// This is a broader check than [`is_always_blocked_ip`] — it includes RFC 1918
/// private ranges (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64.0.0/10`,
/// RFC 6598), other special-use ranges, and IPv6 ULA (`fc00::/7`) which are
/// allowable via `allowed_ips` but blocked by default without one.
///
/// Used by the proxy's default SSRF path and the mechanistic mapper to detect
/// when `allowed_ips` should be populated in proposals.
pub fn is_internal_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_internal_v4(v4),
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if is_link_local_ip(IpAddr::V6(v6)) {
                return true;
            }
            // fc00::/7 — IPv6 unique local addresses (ULA)
            if (v6.segments()[0] & 0xfe00) == 0xfc00 {
                return true;
            }
            // Check IPv4-mapped IPv6 (::ffff:x.x.x.x)
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_internal_v4(v4);
            }
            false
        }
    }
}

/// Check if a CIDR network intersects any address range classified by
/// [`is_internal_ip`].
pub fn is_internal_net(net: IpNet) -> bool {
    if is_always_blocked_net(net) {
        return true;
    }

    match net {
        IpNet::V4(net) => NON_HARD_INTERNAL_V4_NETS
            .iter()
            .any(|internal| ipv4_nets_intersect(net, *internal)),
        IpNet::V6(net) => {
            ipv6_nets_intersect(net, IPV6_ULA_NET)
                || NON_HARD_INTERNAL_V4_NETS
                    .iter()
                    .any(|internal| ipv6_nets_intersect(net, ipv4_net_to_mapped_ipv6(*internal)))
        }
    }
}

/// IPv4 internal address check covering RFC 1918, CGNAT (RFC 6598), and other
/// special-use ranges that should never be reachable from sandbox egress.
fn is_internal_v4(v4: Ipv4Addr) -> bool {
    // Prefer the stable `Ipv4Addr` predicates. `is_documentation()` (RFC 5737)
    // covers all three TEST-NET ranges, including 192.0.2.0/24 (TEST-NET-1) which
    // the previous manual checks missed.
    if v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_documentation()
        || v4.is_broadcast()
    {
        return true;
    }
    let octets = v4.octets();
    // The ranges below have no stable std predicate yet, so keep them manual.
    // 100.64.0.0/10 — CGNAT / shared address space (RFC 6598; `is_shared` is
    // unstable). Commonly used by cloud VPC peering, Tailscale, and similar overlays.
    if octets[0] == 100 && (octets[1] & 0xC0) == 64 {
        return true;
    }
    // 192.0.0.0/24 — IETF protocol assignments (RFC 6890; no stable predicate).
    if octets[0] == 192 && octets[1] == 0 && octets[2] == 0 {
        return true;
    }
    // 198.18.0.0/15 — benchmarking (RFC 2544; `is_benchmarking` is unstable).
    if octets[0] == 198 && (octets[1] & 0xFE) == 18 {
        return true;
    }
    false
}

/// Check if an IP address is a globally routable public unicast address.
///
/// This is the strict predicate behind `public_internet` endpoints. It rejects
/// everything [`is_internal_ip`] rejects (loopback, link-local, unspecified,
/// RFC 1918, CGNAT `100.64.0.0/10`, `192.0.0.0/24`, TEST-NETs, benchmarking
/// `198.18.0.0/15` which also hosts the policy DNS synthetic pools, broadcast,
/// IPv6 ULA `fc00::/7`) and additionally:
///
/// - IPv4 "this network" `0.0.0.0/8`, multicast `224.0.0.0/4`, reserved
///   `240.0.0.0/4` and the deprecated 6to4 relay anycast `192.88.99.0/24`;
/// - every IPv6 address outside global unicast `2000::/3` (multicast, NAT64
///   `64:ff9b::/96`, discard, site-local, ...), plus IETF protocol assignments
///   `2001::/23` (Teredo, ORCHID, ...), 6to4 `2002::/16`, and the documentation
///   ranges `2001:db8::/32` and `3fff::/20`, whose embedded or tunnelled IPv4
///   targets cannot be validated here.
///
/// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are judged by their embedded
/// IPv4 address.
pub fn is_public_internet_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_internet_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_internet_v4(v4);
            }
            let segments = v6.segments();
            // Global unicast 2000::/3 only.
            if (segments[0] & 0xe000) != 0x2000 {
                return false;
            }
            // 2001::/23 — IETF protocol assignments (Teredo 2001::/32, ORCHID).
            if segments[0] == 0x2001 && segments[1] < 0x0200 {
                return false;
            }
            // 2001:db8::/32 — documentation.
            if segments[0] == 0x2001 && segments[1] == 0x0db8 {
                return false;
            }
            // 2002::/16 — 6to4 (embeds an arbitrary IPv4 address).
            if segments[0] == 0x2002 {
                return false;
            }
            // 3fff::/20 — documentation (RFC 9637).
            if segments[0] == 0x3fff && (segments[1] & 0xf000) == 0 {
                return false;
            }
            !is_internal_ip(ip)
        }
    }
}

fn is_public_internet_v4(v4: Ipv4Addr) -> bool {
    if is_internal_v4(v4) {
        return false;
    }
    let octets = v4.octets();
    // 0.0.0.0/8 — "this network".
    if octets[0] == 0 {
        return false;
    }
    // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (includes broadcast).
    if octets[0] >= 224 {
        return false;
    }
    // 192.88.99.0/24 — deprecated 6to4 relay anycast (RFC 7526).
    if octets[0] == 192 && octets[1] == 88 && octets[2] == 99 {
        return false;
    }
    true
}

/// Enable `TCP_NODELAY` on a stream, logging (not returning) any failure.
///
/// Disabling Nagle's algorithm keeps small writes from waiting on delayed ACKs.
/// It's a latency optimization: if it fails the connection still works, just a
/// bit slower, so there is nothing for the caller to act on — we log and move on.
pub fn set_tcp_nodelay_best_effort(stream: &TcpStream) {
    if let Err(e) = stream.set_nodelay(true) {
        tracing::debug!(error = %e, "failed to set TCP_NODELAY");
    }
}

/// Connect to `addrs`, then enable `TCP_NODELAY` on a best-effort basis, propagating
/// any errors from `TcpStream::connect`.
///
/// The returned stream is not *guaranteed* to have `TCP_NODELAY` set.
pub async fn connect_tcp_nodelay_best_effort(addrs: &[SocketAddr]) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect(addrs).await?;
    set_tcp_nodelay_best_effort(&stream);
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- is_public_internet_ip --

    #[test]
    fn test_public_internet_accepts_global_unicast() {
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.215.14",
            "140.82.112.3",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.167.255.255",
            "192.169.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.254",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4007:80e::200e",
            "::ffff:8.8.8.8",
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(is_public_internet_ip(ip), "{ip} should be public");
        }
    }

    #[test]
    fn test_public_internet_rejects_every_non_public_range() {
        for ip in [
            // always-blocked
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "169.254.0.1",
            "0.0.0.0",
            // "this network"
            "0.1.2.3",
            // RFC 1918
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.1",
            "192.168.255.254",
            // CGNAT / Tailscale
            "100.64.0.1",
            "100.64.0.42",
            "100.100.100.100",
            "100.127.255.254",
            // IETF assignments, TEST-NETs, benchmarking / policy DNS pool
            "192.0.0.8",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "198.18.0.1",
            "198.19.255.254",
            // 6to4 relay anycast
            "192.88.99.1",
            // multicast, reserved, broadcast
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            // IPv6 loopback / unspecified / link-local / ULA / multicast
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd7a:115c:a1e0::1",
            "ff02::1",
            // IPv6 special-purpose inside and outside 2000::/3
            "64:ff9b::a00:1",
            "64:ff9b::808:808",
            "100::1",
            "2001::1",
            "2001:db8::1",
            "2002:a00:1::1",
            "3fff::1",
            "fec0::1",
            // IPv4-mapped private / metadata
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:127.0.0.1",
            "::ffff:100.100.100.100",
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!is_public_internet_ip(ip), "{ip} must not be public");
        }
    }

    #[test]
    fn test_public_internet_is_stricter_than_internal_check() {
        // Every address rejected by the default SSRF check is also rejected
        // by the public-internet predicate.
        for ip in [
            "10.1.2.3",
            "100.64.0.1",
            "198.18.0.5",
            "fd00::1",
            "::ffff:192.168.1.1",
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(is_internal_ip(ip));
            assert!(!is_public_internet_ip(ip));
        }
    }

    // -- is_known_metadata_hostname --

    #[test]
    fn test_known_metadata_hostname_accepts_gcp_variants() {
        assert!(is_known_metadata_hostname("metadata.google.internal"));
        assert!(is_known_metadata_hostname("METADATA.GOOGLE.INTERNAL"));
        assert!(is_known_metadata_hostname("metadata.google.internal."));
    }

    #[test]
    fn test_known_metadata_hostname_rejects_public_hosts() {
        assert!(!is_known_metadata_hostname("api.github.com"));
        assert!(!is_known_metadata_hostname(""));
    }

    // -- is_link_local_ip --

    #[test]
    fn test_link_local_ip_v4() {
        assert!(is_link_local_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 0, 1))));
        assert!(is_link_local_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
        assert!(is_link_local_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 255, 255
        ))));
    }

    #[test]
    fn test_link_local_ip_v6_fe80() {
        assert!(is_link_local_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));
        // Upper boundary of fe80::/10 (febf:...)
        assert!(is_link_local_ip(IpAddr::V6(Ipv6Addr::new(
            0xfebf, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn test_link_local_ip_v6_mapped_v4() {
        let mapped = Ipv4Addr::new(169, 254, 1, 2).to_ipv6_mapped();
        assert!(is_link_local_ip(IpAddr::V6(mapped)));
    }

    #[test]
    fn test_link_local_ip_not_loopback() {
        assert!(!is_link_local_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_link_local_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn test_link_local_ip_not_unspecified() {
        assert!(!is_link_local_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(!is_link_local_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
    }

    #[test]
    fn test_link_local_ip_not_rfc1918() {
        assert!(!is_link_local_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!is_link_local_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1))));
        assert!(!is_link_local_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
    }

    #[test]
    fn test_link_local_ip_not_public() {
        assert!(!is_link_local_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_link_local_ip(IpAddr::V6(Ipv6Addr::new(
            0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888
        ))));
    }

    #[test]
    fn test_link_local_ip_not_v6_mapped_loopback() {
        let mapped = Ipv4Addr::LOCALHOST.to_ipv6_mapped();
        assert!(!is_link_local_ip(IpAddr::V6(mapped)));
    }

    // -- is_always_blocked_ip --

    #[test]
    fn test_always_blocked_ip_loopback_v4() {
        assert!(is_always_blocked_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            127, 0, 0, 2
        ))));
    }

    #[test]
    fn test_always_blocked_ip_link_local_v4() {
        assert!(is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
        assert!(is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 0, 1
        ))));
    }

    #[test]
    fn test_always_blocked_ip_loopback_v6() {
        assert!(is_always_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn test_always_blocked_ip_link_local_v6() {
        assert!(is_always_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn test_always_blocked_ip_unspecified_v4() {
        assert!(is_always_blocked_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
    }

    #[test]
    fn test_always_blocked_ip_unspecified_v6() {
        assert!(is_always_blocked_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
    }

    #[test]
    fn test_always_blocked_ip_ipv4_mapped_v6_loopback() {
        let v6 = Ipv4Addr::LOCALHOST.to_ipv6_mapped();
        assert!(is_always_blocked_ip(IpAddr::V6(v6)));
    }

    #[test]
    fn test_always_blocked_ip_ipv4_mapped_v6_link_local() {
        let v6 = Ipv4Addr::new(169, 254, 169, 254).to_ipv6_mapped();
        assert!(is_always_blocked_ip(IpAddr::V6(v6)));
    }

    #[test]
    fn test_always_blocked_ip_allows_rfc1918() {
        assert!(!is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            10, 0, 0, 1
        ))));
        assert!(!is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            172, 16, 0, 1
        ))));
        assert!(!is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            192, 168, 0, 1
        ))));
    }

    #[test]
    fn test_always_blocked_ip_allows_public() {
        assert!(!is_always_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_always_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888
        ))));
    }

    // -- is_always_blocked_net --

    #[test]
    fn test_always_blocked_net_loopback_v4() {
        let net: IpNet = "127.0.0.0/8".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_link_local_v4() {
        let net: IpNet = "169.254.0.0/16".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_unspecified_v4() {
        let net: IpNet = "0.0.0.0/32".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_loopback_v6() {
        let net: IpNet = "::1/128".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_link_local_v6() {
        let net: IpNet = "fe80::/10".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_ipv4_mapped_v6_loopback() {
        let net: IpNet = "::ffff:127.0.0.1/128".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_allows_rfc1918() {
        let net10: IpNet = "10.0.0.0/8".parse().unwrap();
        let net172: IpNet = "172.16.0.0/12".parse().unwrap();
        let net192: IpNet = "192.168.0.0/16".parse().unwrap();
        assert!(!is_always_blocked_net(net10));
        assert!(!is_always_blocked_net(net172));
        assert!(!is_always_blocked_net(net192));
    }

    #[test]
    fn test_always_blocked_net_allows_public() {
        let net: IpNet = "8.8.8.0/24".parse().unwrap();
        assert!(!is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_single_ip_loopback() {
        let net: IpNet = "127.0.0.1/32".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_single_ip_metadata() {
        let net: IpNet = "169.254.169.254/32".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_broad_cidr_containing_blocked() {
        // 0.0.0.0/0 contains everything including unspecified, loopback, link-local
        let net: IpNet = "0.0.0.0/0".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_v6_broad_containing_loopback() {
        let net: IpNet = "::/0".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_v6_ipv4_mapped_loopback_single() {
        let net: IpNet = "::ffff:127.0.0.1/128".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_v6_ipv4_mapped_link_local_single() {
        let net: IpNet = "::ffff:169.254.0.1/128".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_v6_ipv4_mapped_broad_spans_link_local() {
        // ::ffff:168.0.0.0/103 has a public network address (168.0.0.0) but
        // the range covers 168.0.0.0–169.255.255.255, which includes the
        // link-local block 169.254.0.0/16.
        let net: IpNet = "::ffff:168.0.0.0/103".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_v6_ipv4_mapped_broad_spans_loopback() {
        // ::ffff:64.0.0.0/98 has a public network address (64.0.0.0) but the
        // range covers 64.0.0.0–127.255.255.255, which includes loopback.
        let net: IpNet = "::ffff:64.0.0.0/98".parse().unwrap();
        assert!(is_always_blocked_net(net));
    }

    #[test]
    fn test_always_blocked_net_v6_ipv4_mapped_allows_public() {
        // ::ffff:8.8.8.8/128 is a public address — should not be blocked.
        let net: IpNet = "::ffff:8.8.8.8/128".parse().unwrap();
        assert!(!is_always_blocked_net(net));
    }

    // -- is_internal_net --

    #[test]
    fn test_internal_net_rfc1918_contained_and_supernet() {
        for cidr in ["10.1.0.0/16", "8.0.0.0/5"] {
            assert!(is_internal_net(cidr.parse().unwrap()), "{cidr}");
        }
    }

    #[test]
    fn test_internal_net_cgnat_contained_and_supernet() {
        for cidr in ["100.64.0.0/10", "100.0.0.0/9"] {
            assert!(is_internal_net(cidr.parse().unwrap()), "{cidr}");
        }
    }

    #[test]
    fn test_internal_net_ipv4_special_use_ranges() {
        for cidr in [
            "192.0.0.0/24",
            "192.0.2.0/24",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "255.255.255.255/32",
        ] {
            assert!(is_internal_net(cidr.parse().unwrap()), "{cidr}");
        }
    }

    #[test]
    fn test_internal_net_ipv6_ula() {
        for cidr in ["fc00::/7", "fd00::/8"] {
            assert!(is_internal_net(cidr.parse().unwrap()), "{cidr}");
        }
    }

    #[test]
    fn test_internal_net_ipv4_mapped_cgnat_supernet() {
        let net: IpNet = "::ffff:100.0.0.0/105".parse().unwrap();
        assert!(is_internal_net(net));
    }

    #[test]
    fn test_internal_net_always_blocked() {
        for cidr in ["127.0.0.0/8", "fe80::/10"] {
            assert!(is_internal_net(cidr.parse().unwrap()), "{cidr}");
        }
    }

    #[test]
    fn test_internal_net_allows_large_public_ranges() {
        for cidr in ["8.0.0.0/8", "::ffff:8.0.0.0/104"] {
            assert!(!is_internal_net(cidr.parse().unwrap()), "{cidr}");
        }
    }

    // -- is_internal_ip --

    #[test]
    fn test_internal_ip_rfc1918() {
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1))));
    }

    #[test]
    fn test_internal_ip_loopback() {
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_internal_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn test_internal_ip_link_local() {
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
    }

    #[test]
    fn test_internal_ip_unspecified() {
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_internal_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
    }

    #[test]
    fn test_internal_ip_v6_ula() {
        assert!(is_internal_ip(IpAddr::V6(Ipv6Addr::new(
            0xfc00, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_internal_ip(IpAddr::V6(Ipv6Addr::new(
            0xfd00, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn test_internal_ip_allows_public() {
        assert!(!is_internal_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_internal_ip(IpAddr::V6(Ipv6Addr::new(
            0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888
        ))));
    }

    #[test]
    fn test_internal_ip_ipv4_mapped_v6() {
        let v6 = Ipv4Addr::new(10, 0, 0, 1).to_ipv6_mapped();
        assert!(is_internal_ip(IpAddr::V6(v6)));
        let v6_public = Ipv4Addr::new(8, 8, 8, 8).to_ipv6_mapped();
        assert!(!is_internal_ip(IpAddr::V6(v6_public)));
    }

    #[test]
    fn test_internal_ip_cgnat() {
        // 100.64.0.0/10 — CGNAT / shared address space (RFC 6598)
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(100, 100, 50, 3))));
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(
            100, 127, 255, 255
        ))));
        // Just outside the /10 boundary
        assert!(!is_internal_ip(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))));
        assert!(!is_internal_ip(IpAddr::V4(Ipv4Addr::new(
            100, 63, 255, 255
        ))));
    }

    #[test]
    fn test_internal_ip_special_use_ranges() {
        // 192.0.0.0/24 — IETF protocol assignments
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 0, 1))));
        // 198.18.0.0/15 — benchmarking
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))));
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(198, 19, 255, 255))));
        // 192.0.2.0/24 — TEST-NET-1 (RFC 5737), now covered via is_documentation()
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))));
        // 198.51.100.0/24 — TEST-NET-2
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1))));
        // 203.0.113.0/24 — TEST-NET-3
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1))));
        // 255.255.255.255 — limited broadcast (RFC 919), via is_broadcast()
        assert!(is_internal_ip(IpAddr::V4(Ipv4Addr::BROADCAST)));
    }

    #[test]
    fn test_internal_ip_ipv6_mapped_cgnat() {
        let v6 = Ipv4Addr::new(100, 64, 0, 1).to_ipv6_mapped();
        assert!(is_internal_ip(IpAddr::V6(v6)));
    }

    // -- tcp_nodelay helpers --

    #[tokio::test]
    async fn set_tcp_nodelay_best_effort_enables_nodelay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let stream = TcpStream::connect(addr).await.expect("connect");

        set_tcp_nodelay_best_effort(&stream);
        assert!(stream.nodelay().expect("query TCP_NODELAY"));
    }

    #[tokio::test]
    async fn connect_tcp_nodelay_best_effort_sets_nodelay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let stream = connect_tcp_nodelay_best_effort(&[addr])
            .await
            .expect("connect");
        assert!(stream.nodelay().expect("query TCP_NODELAY"));
    }
}

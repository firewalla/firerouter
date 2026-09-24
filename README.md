# FireRouter

FireRouter is the network management layer that runs on Firewalla devices. It takes a declarative
description of the desired network — interfaces, addressing, routing, DNS, DHCP, NAT — and is
responsible for making the box match it, and for keeping it that way as the network changes
underneath.

It is the component that turns "this port is a WAN on DHCP, these three are a LAN bridge on
10.0.0.1/24, fail over to LTE if the cable drops" into the actual interface, route, firewall and
daemon state on a Linux system.

## What it manages

- **Interfaces** — physical ports, VLANs, bonds, bridges, PPPoE, WireGuard and OpenVPN tunnels
- **Routing** — multi-WAN with failover and load balancing, policy routing, per-interface routing tables
- **DNS and DHCP** — upstream resolver selection, per-network DHCP service, IPv6 (SLAAC, DHCPv6, prefix delegation)
- **NAT** — source NAT, port forwarding, and pass-through modes
- **Wi-Fi** — access point and client modes
- **Local network services** — mDNS reflection across networks, IGMP/multicast proxying, UPnP

## How it works

**Configuration is declarative.** The whole network is described by a single JSON document — the
desired state, not a sequence of commands. Applying a new configuration is a diff against the
active one.

**Each subsystem is a plugin.** A plugin owns one slice of the network (a bridge, the routing
table, the DNS service) and knows how to apply and tear down just that slice. On a change, the
plugin loader works out which plugins are actually affected, then tears down and re-applies only
those, in dependency order — so editing a DNS server does not bounce an unrelated interface.

**Sensors watch the running system.** Link up/down, a DHCP lease that brings a new address, a WAN
that stops answering — these arrive as events, and the affected plugins re-apply in place. Most of
what FireRouter does at runtime is reacting to the network rather than being told about it.

## HTTP API

FireRouter exposes a small HTTP API on localhost (port 8837 by default) for the rest of the
system to drive it:

| Endpoint | Purpose |
|---|---|
| `GET /v1/config/active` | the configuration currently applied |
| `POST /v1/config/set` | validate and apply a new configuration |
| `GET /v1/config/interfaces` | interface configuration and live state |
| `GET /v1/config/wans` · `/lans` | WAN and LAN views, including connectivity state |
| `GET /v1/config/wan/connectivity` | per-WAN reachability as last measured |

Applying a configuration is transactional: if it fails to come up, FireRouter rolls back to the
previous one rather than leaving the box unreachable.

## Repository layout

| Path | Contents |
|---|---|
| `plugins/` | one directory per subsystem — `interface`, `routing`, `dns`, `dhcp`, `nat`, … |
| `sensors/` | runtime event watchers that trigger re-apply |
| `core/` | configuration management, validation, and the apply pipeline |
| `service/` | the HTTP API |
| `platform/` | per-model hardware abstraction, selected at runtime |
| `scripts/` | systemd units and system integration |
| `etc/` | templates for the daemons FireRouter drives |

## Building and testing

FireRouter is built to run as a systemd service on Firewalla hardware, against that system's
kernel, network daemons and platform scripts. It is not intended to be a general-purpose network
manager for arbitrary Linux machines, and it will not do anything useful if pointed at one.

## Contributing

Bug reports and pull requests are welcome via
[GitHub issues](https://github.com/firewalla/firerouter/issues).

## License

Licensed under the [GNU Affero General Public License v3](LICENSE).

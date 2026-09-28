# Changelog

## 0.1.1

- Sends Home Assistant state snapshots only to authenticated remote clients.
- Directs bridge discovery and login traffic to the intended participant.

## 0.1.0

- Initial Home Assistant add-on package.
- Uses the Supervisor WebSocket proxy instead of a long-lived HA token.
- Includes an ingress-only entity picker.
- Supports an explicit local entity allow-list.

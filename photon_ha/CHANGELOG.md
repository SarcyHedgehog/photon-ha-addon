# Changelog

## 0.2.1

- Migrates the Study heater permission from the obsolete `fan.office_heater` entity
  to `switch.heater`, including existing installations that retain the old option.

## 0.2.0

- Adds separate Remote and Study passwords.
- Filters snapshots and commands using bridge-enforced per-view entity permissions.
- Keeps upgrades compatible by temporarily falling back to the Remote password when
  the new Study password has not yet been set.

## 0.1.2

- Shares selected light colour and brightness attributes with authenticated remote views.

## 0.1.1

- Sends Home Assistant state snapshots only to authenticated remote clients.
- Directs bridge discovery and login traffic to the intended participant.

## 0.1.0

- Initial Home Assistant add-on package.
- Uses the Supervisor WebSocket proxy instead of a long-lived HA token.
- Includes an ingress-only entity picker.
- Supports an explicit local entity allow-list.

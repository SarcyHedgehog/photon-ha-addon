# Photon HA Bridge

Photon HA Bridge relays only the Home Assistant entities you explicitly select
through a private Photon Realtime room.

## Configuration

- **Photon App ID**: the Realtime App ID from your Photon dashboard.
- **Photon region**: normally `eu`.
- **Room name**: a private, hard-to-guess room name unique to this installation.
- **Remote password**: a strong password entered by remote users.
- **Study password**: a different password for the 3D Study. If left blank during
  an upgrade, it temporarily falls back to the Remote password.
- **Study entities**: the entity IDs the Study profile may receive or control.
- **Debug**: leave disabled unless diagnosing a connection problem.

The add-on receives a short-lived internal Home Assistant token from Supervisor.
You do not need to create or store a Home Assistant long-lived access token.

## Selecting entities

After the add-on starts, choose **Open Web UI**. Select no more than 100 entities,
give them friendly remote names, and choose whether each one is view-only or
controllable. Nothing is exposed until it has been selected and saved.

## Security

- Home Assistant is not exposed directly to the internet.
- The public remote never receives a Home Assistant token.
- All snapshots and commands are checked against both the local entity allow-list
  and the authenticated view's access profile.
- Use a unique room name and different strong passwords for Remote and Study.

The current password protocol is suitable for private testing. Before offering
the bridge as a general public service, replace it with Photon Custom
Authentication or a short-lived signed-token service.

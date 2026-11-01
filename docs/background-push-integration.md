# Background notifications

Baskule can notify signed-in people about approval requests, input requests, completed tasks, and failures. Personal background notifications require authenticated accounts. Mobile **Settings > Notifications** registers the device and selects alert types.

An administrator configures providers under **Administration > Organization > Mobile notifications**. Credentials are write-only. Reads expose configured app IDs and availability. Removing a provider stops new sends through that provider.

- APNs requires the signed app's bundle ID, Apple team ID, key ID, private key, and permitted sandbox or production environments.
- FCM requires the signed app's application ID and a Firebase service account with messaging permission.
- Android builds need matching Firebase configuration and the native notification module. iOS builds need matching push entitlements and an APNs environment.

## Storage and delivery

Registrations and provider credentials stay in ControlCell. Chat events commit notification effects to SpaceCell's outbox. Its existing alarm retries pending delivery. Delivery checks the current session, membership, preferences, and committed chat state before sending. Re-enrollment transfers the native token to the current account and session.

Delivery is at least once. A crash after provider acceptance but before saving the receipt can cause a duplicate. A notification accepted by APNs or FCM cannot be recalled. An offline account switch cannot revoke a registration on an unreachable server. Successful re-enrollment prevents subsequent sends through the old registration.

## Installation requirements

ControlCell stores device registrations and delivery receipts. Follow [the deployment upgrade procedure](../deploy/README.md#upgrade) when updating the installation. Recreate installation settings and accounts after a data wipe required by a release.

Provider delivery requires credentials, outbound access, APNs HTTP/2 support where applicable, and a matching native build. Simulated provider checks establish request and retry behavior. Receipt on a real background device and notification taps need separate device verification.

# Social Sign-In

Use current primary documentation for each provider and runtime.

## Workflow

1. Identify provider, platform, auth library, app identifier, build profile, backend exchange, account-linking policy, and signed artifact under test.
2. Trace provider result, backend verification, account decision, session persistence, sign-out, deletion, and revocation.
3. Match provider-console identity to the artifact users run:
   - Google Android: package plus the installed artifact's signing certificate, including Play app signing.
   - Google iOS: bundle, iOS client, and redirect scheme.
   - Google backend: verified token issuer and server audience.
   - Apple: bundle, team, capability, entitlement, provisioning profile, and verified provider subject.
4. Fix the failing boundary. Rebuild after native dependency, plugin, identifier, capability, entitlement, provisioning, signing, service-file, or
   build-time configuration changes.
5. Test changed providers on the signed artifacts users receive: backend acceptance, account selection/linking, persisted session, cancellation,
   rejection, collision, sign-out, and retry. Opening provider UI proves none of these.

## Invariants

- Authenticate with provider-verifiable credentials, never a client-supplied provider user ID.
- Use the verified provider subject as durable identity; do not link accounts by email alone.
- Keep mobile, server, debug, upload, store-signing, and production identities distinct.
- Log stages and safe error codes, never raw credentials or tokens.

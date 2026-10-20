# In-App Payments

Use current primary documentation for the purchase library, store billing, server APIs, notifications, and payment policies.

Define product type, store IDs, grant, owning account/tenant, backend authority, provider-scoped idempotency key, completion owner, restore path,
and refund policy before coding.

## Workflow

1. Map active store products to the backend catalog, which determines entitlements; never trust client price, label, package, or quantity.
2. Trace product fetch, purchase result, backend provider verification, app/product/account checks, transactional grant, store completion, entitlement
   refresh, restore, and refund reconciliation.
3. Persist grant and completion separately so completion retries cannot grant twice.
4. Rebuild after native library, plugin, app ID, capability, service-file, or build-time configuration changes.
5. Prove a real sandbox purchase on each changed signed platform artifact: grant, persistence after restart, completion, repeat purchase for
   consumables, or restore for durable products.
6. Implement refund/revocation reconciliation before launch, or record the manual policy and owner.

## Invariants

- One provider transaction or purchase token grants at most once and cannot grant across accounts or tenants.
- Only a provider-verified completed purchase grants value; pending purchases wait.
- Apply the backend grant transactionally before store completion.
- Grant, completion, and refund recovery are independently retryable and idempotent.
- Google consumables are consumed after durable grant; non-consumables and subscriptions are acknowledged when required.
- Apple transactions are finished by the chosen owner after durable backend grant.
- Refund reversal preserves audit history and never removes value twice.
- Never log raw purchase tokens, signed payloads, credentials, authorization headers, or full provider responses.

Report product and store states, signed artifacts tested, safe stage evidence, refund coverage, and unproven risks. Navigation or catalog UI proves no sale,
verification, grant, or completion.

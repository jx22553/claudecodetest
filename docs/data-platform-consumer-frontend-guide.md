# The Consumer-Facing Front End — Knowledge Catalog and Access Portal

This document is the counterpart to the portal guide, for a completely different audience. The portal guide covers a producer watching their own deployment. This document covers a **consumer** — someone who doesn't own any data on this platform, wants to *use* someone else's, and has never touched `.dataplatform/` or opened a PR.

There are genuinely two separate front ends involved here, built by two different parties, and it's worth being precise about where one ends and the other begins.

---

## Surface one: Knowledge Catalog's own UI — Google's, not ours

Everything up through "access approved" happens in **Google's own console**, not anything this platform built:

- A consumer browses Knowledge Catalog's **Data Products** page, searches for a producer's data product, and reads its description, documentation, and aspects — all populated from the custom Entry `saga.workflow` wrote at deploy time (see the main architecture document, §14).
- They click **Request access**, pick an **access group** (the specific consumption pattern matching their use case — direct access, a dedicated Kafka topic, or a REST API), write a justification, and submit.
- Google's own workflow tracks the request (New → Approved/provisioning → Rejected), routes it to the data product's configured approvers, and sends the email notification on a decision.
- Optionally, instead of Google's console, an organization can stand up Google's **open-source reference UI** (`knowledge-catalog-business-user-interface`) as a more tailored front door to the same underlying API — still Google's design, just self-hosted and reskinned rather than built from scratch.

**Nothing in this platform's own codebase renders any of the above.** There's no repo directory for it, no deploy pipeline, because there's nothing to deploy — it's a capability Knowledge Catalog already ships.

---

## Surface two: `access-portal` — ours, and it starts exactly where surface one ends

The approval email's link is where Google's UI hands off to something this platform built. `access-portal/frontend/` is a **separate deployable from `portal/`** — different repo directory, different audience, different purpose, and worth never conflating with the producer-facing portal covered in the other guide.

### Why it's a separate thing, not a page bolted onto the producer portal

- **Different audience.** `portal/` is for a producer watching infrastructure they own get built. `access-portal/` is for a consumer who owns nothing here and just wants to know what they can query.
- **Different purpose.** `portal/` answers "is my deployment working." `access-portal/` answers "what exactly am I allowed to call, and how."
- **Different trigger.** `portal/` gets bookmarked once and returned to indefinitely. `access-portal/` gets reached almost entirely from one specific link, in one specific email, at one specific moment — approval.

### Why it doesn't need its own backend

This is the one place this design gets *simpler* than the producer portal, not more complex. `portal/` needs `portal/backend` because it aggregates two independent sources (Firestore and Confluent's Metrics API) into one view. `access-portal/frontend/` doesn't need any of that — it calls `egress-api`'s own discovery and OpenAPI routes **directly**, client-side, the same way any real consumer's actual code eventually will. Those routes already do all the real work: resolving the caller's identity from their token, checking their Firestore grant, checking the live BigQuery/Bigtable schema. `access-portal` is, quite literally, just a nicer way of looking at exactly what `egress-api` would tell you anyway.

### What the page actually shows

Landing on `access-portal` after approval, a consumer sees:

- Which tables their specific grant covers — not every table in the underlying dataset, only the ones approved (the intersection of what exists and what they're allowed to see, computed live, not hardcoded).
- Each table's real columns, fetched live from the storage backend's own schema — which is why this page can never describe a column that doesn't actually exist, or miss one that was just added.
- A ready-to-copy `curl` example per table, with the consumer's real producer ID and table names already filled in — nothing to substitute by hand.
- A link to the same information as a machine-readable `openapi.json`, for anyone who'd rather import this into Postman or generate a typed client than read a rendered page.

**Why this can never go stale, structurally, not just by discipline:** the page isn't a snapshot captured once at approval time. Every time it loads, it makes the same live calls `egress-api` itself answers on every real request. If a producer adds a column tomorrow, or an approver narrows the grant next month, the page reflects that on the next load — there's no separate documentation artifact anyone has to remember to update, because there is no separate artifact.

### Credentials are handled outside this page entirely

The approval email links to `access-portal`, but it never carries the actual API token — email is not where a live credential should travel. Delivery happens one of two ways, matching how every other credential in this system is handled:

- **A human consumer** gets a one-time reveal inside `access-portal`, behind the same SSO gate used everywhere else in this platform.
- **A programmatic caller** (a service account) picks up its credential via a Secret Manager reference, the same pattern used for every other machine identity in this design — never a value pasted anywhere.

---

## The full handoff, start to finish

1. Consumer browses and requests access in **Knowledge Catalog's UI** (Google's).
2. Producer's team approves in the **same UI** (Google's).
3. Email notification links to **`access-portal`** (this platform's).
4. `access-portal` calls **`egress-api`** directly (this platform's) to render live docs.
5. Consumer copies a `curl` command and starts calling `egress-api` themselves — the exact same endpoint `access-portal` was just showing them, not a different one.

Three parties, two systems, one live source of truth — Knowledge Catalog never needs to know what `egress-api`'s schema looks like, and `egress-api` never needs to know anything about how a request got approved.

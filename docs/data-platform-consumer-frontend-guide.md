# The Consumer-Facing Front End — Knowledge Catalog and Access Portal

This document is the counterpart to the portal guide, for a completely different audience. The portal guide covers a producer watching their own deployment. This document covers a **consumer** — someone who doesn't own any data on this platform, wants to *use* someone else's, and has never touched `.dataplatform/` or opened a PR.

There are genuinely two separate front ends involved here, built by two different parties, and it's worth being precise about where one ends and the other begins.

---

## Knowledge Catalog's own UI — Google's native UI

Everything up through "access approved" happens in **Google's own console**, not anything this platform built:

- A consumer browses Knowledge Catalog's **Data Products** page, searches for a producer's data product, and reads its description, documentation, and aspects — all populated from the custom Entry `saga.workflow` wrote at deploy time (see the main architecture document, §11).
- They click **Request access**, pick an **access group** (the specific consumption pattern matching their use case — direct access, a dedicated Kafka topic, or a REST API), write a justification, and submit.
- Google's own workflow tracks the request (New → Approved/provisioning → Rejected), routes it to the data product's configured approvers, and sends the email notification on a decision.
- Optionally, instead of Google's console, an organization can stand up Google's **open-source reference UI** (`knowledge-catalog-business-user-interface`) as a more tailored front door to the same underlying API — still Google's design, just self-hosted and reskinned rather than built from scratch.

**Nothing in this platform's own codebase renders any of the above.** There's no repo directory for it, no deploy pipeline, because there's nothing to deploy — it's a capability Knowledge Catalog already ships.

### What a consumer actually sees before requesting anything: the data contract

This is the part worth walking through precisely, since "read the SLA before you commit to using this data" is exactly what the Data Product page is for. The object model, applied to one real example:

- **Entry** — the canonical pointer to `orders-team`'s data, the same object `saga.workflow` writes to on every deploy.
- **Entry Type** — declares that no Entry of this type counts as complete without both a Schema Aspect and a **`DataContract` Aspect**. This is what makes "producer states their commitments" enforced rather than optional — a Data Product literally cannot go live without it.
- **The `DataContract` Aspect itself** — five typed, individually queryable fields, compiled straight from `contract/contract.yaml`:
```
  freshness_sla_minutes: 15
  uptime_commitment_pct: 99.9
  breaking_change_notice_days: 30
  support_contact: orders-team@company.com
  full_contract_document_url: gs://contracts-bucket/orders-team/CONTRACT.md
```
- **The fifth field is the one worth being precise about.** Aspects don't support file attachments — they're structured, schema-enforced fields, not a place to drop a PDF. So the longer, written `CONTRACT.md` a producer authors lives outside Knowledge Catalog entirely, in a Cloud Storage bucket, and the Aspect only holds a link to it. A consumer sees the four structured commitments rendered directly on the Data Product page — the numbers they can search and compare across every data product in the catalog — with a link out to the fuller document for anyone who wants the complete written context.
- **Where the underlying data actually comes from is traceable, not asserted.** The Data Product wraps this same Entry, so everything a consumer reads on that page — the SLA, the schema, the columns — is the same object `saga.workflow` populated, not a separate summary someone maintains by hand.

---

## 
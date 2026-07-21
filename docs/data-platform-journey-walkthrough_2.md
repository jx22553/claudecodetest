# The Data Platform Journey — Step by Step

This document follows one thing happening: a producer creates or updates a data contract and that change ends up flowing all the way to a published Kafka message, and separately, how a consumer finds and consumes that data afterward. It's organized in the exact sequence things actually happen, in nine phases — not by component, but by time.

---

## Phase 1 — Portal: contract authoring

Nothing in this phase requires a terminal, a git client, or any local tooling. It all happens in the producer's browser.

1. The producer opens the **data platform portal** and clicks **New contract** on the home dashboard. This opens a guided multi-step form covering everything that needs to be declared:

   - **Schema definition** — a form-based field builder: add fields, set types, mark optional or required. Produces a valid `.proto` file behind the scenes; the producer never writes protobuf syntax directly.
   - **Ingestion method** — choose between two paths:
     - **Dataflow pull** — the producer already owns a Kafka or Pub/Sub topic, and the platform will pull from it. Requires the source topic connection details and a Secret Manager credential reference. Two prerequisites must be satisfied before this path can successfully apply: the topic must already exist (the platform never creates it) and the producer must have already granted the platform's designated service account read access (a Pub/Sub IAM binding or Kafka ACL, done outside the portal).
     - **REST publisher** — the producer's application will POST events directly to the platform's `rest-publisher` Cloud Run service. No pre-existing topic required. The producer declares a service account that will be granted `roles/run.invoker` on the publisher.
   - **Egress target** — a storage target dropdown (`bigquery`, `bigtable`, `cloud_storage`, `pubsub_topic`, etc.). The form adapts to show only the relevant config fields for that target.
   - **SLA commitments** — structured fields: `freshness_sla_minutes`, `uptime_commitment_pct`, `breaking_change_notice_days`, `support_contact`. An optional free-text editor for `CONTRACT.md` appears below them.

2. The producer submits the form. **`portal/backend`'s `contract-api/`** takes over:

   a. Runs `shared/validation-lib` and `shared/policy-bundles` on the submitted data — the same validation CI will run, before any file reaches git. If validation fails, field-level errors are returned immediately and the form stays open. Nothing is written anywhere until this passes.

   b. Generates the canonical contract files (`schema/orders.proto`, `ingestion/ingestion.yaml`, `egress/egress.yaml`, `contract/contract.yaml`, and optionally `contract/CONTRACT.md`) via `shared/contract-compiler`.

   c. Commits those files to `data-contracts/producers/{producer_id}/.dataplatform/` in the **platform-owned `data-contracts/` monorepo**, using a platform-managed GitHub App credential stored in Secret Manager. The producer's own repo is not touched — all contracts live in one place, owned and auditable by the platform team.

   d. Opens a pull request against `data-contracts/`'s main branch and returns the PR details to the frontend.

   e. Appends a pending deployment event to Firestore's lineage log for this producer, so the portal's deployment status view immediately shows the in-progress state.

3. The portal navigates the producer to their deployment status view, where they can watch the rest of the journey unfold.

Nothing in step 2 above has mutated any GCP infrastructure yet — it has only written files to git and started a Firestore lineage record.

---

## Phase 2 — data-contracts/ PR and CI trigger

4. The PR `contract-api` opened triggers the **CI Actions** workflow (`data-contracts/.github/workflows/ci.yml`), authenticating via Workload Identity Federation — no stored secret. This workflow lives in the `data-contracts/` monorepo and covers every contract in the platform; there is no per-producer workflow file to maintain.

---

## Phase 3 — CI: plan only (server-side, read-only)

Everything from here on runs in GCP — but nothing in this phase can mutate anything.

5. CI Actions calls the **`/ci` route** on `provisioning-api` (`provisioning-api/routes/ci.go`) for the changed producer path.
6. `/ci` runs validation and policy checks, then triggers **`terraform-plan-job`** — a Cloud Run Job running under a read-only service account.
7. Inside the Job, `entrypoint.sh` checks out the PR's commit, runs `contract-compiler` to turn `.dataplatform/` into `terraform.tfvars.json`, then runs `terraform plan` against the producer's isolated Terraform state.
8. `terraform plan` queries **Confluent Cloud and the relevant Google Cloud APIs read-only** to compute the diff — it creates, modifies, or deletes nothing. This is enforced by the Job's service account permissions, not just by convention.
9. `/ci` formats that plan and **surfaces the result in the portal's deployment status view** for this producer — so the producer watching their status page sees exactly what will change before anyone approves the PR. The plan result also posts as a status check on the PR itself.

---

## Phase 4 — Review and merge

10. A platform team member (or an auto-approval policy, for schema-compatible changes with no structural impact) reviews the plan, checks the diff makes sense, and **approves and merges** the PR into `data-contracts/` main.
11. GitHub triggers the **CD Actions** workflow (`data-contracts/.github/workflows/cd.yml`) on the same monorepo.

---

## Phase 5 — CD: apply (the saga)

12. CD Actions calls the **`/cd` route** — the *same* `provisioning-api` service as `/ci`, same deploy, same service account.
13. `/cd` starts an execution of **`saga.workflow`** (`orchestrator/saga.workflow.yaml`) and returns immediately with an execution ID rather than holding the connection open.
14. `saga.workflow` triggers **`terraform-apply-job`** — the same container image as the plan Job, but a separate Cloud Run Job resource running under a *write-scoped* service account, deliberately not run inline inside `provisioning-api` itself (five separate reasons for that, covering timeout limits, instance churn, IAM separation, blast radius, and resource sizing — see §5 of the architecture document).
15. Inside the Job: checkout the merge commit → `contract-compiler` → `terraform apply` against the producer's isolated state.

**If this succeeds:**

16. Terraform's Confluent and Google providers actually **create or modify the real resources** — the Kafka topic, the schema registration in Confluent Schema Registry, IAM grants, and a **Confluent managed sink connector** (BigQuery Sink V2, BigTable Sink, etc.) that continuously moves data from the internal topic into whatever `egress.yaml` declared. No custom pipeline for the egress leg — it's a fully-managed connector, provisioned as one more resource in the same module. Where no managed connector exists for the declared target, an `egress-fanout-pipeline` Dataflow relay job is provisioned as the fallback.
17. For producers on the **Dataflow pull path**, this same apply provisions a pull subscription against the producer's source topic (a Pub/Sub subscription or Kafka consumer group, per `source.type`) and a **Dataflow job** from `pull-ingestion-pipeline/`'s Flex Template. For producers on the **REST publisher path**, it grants the producer's declared service account `roles/run.invoker` on the `rest-publisher` Cloud Run service — no Dataflow job is provisioned.
18. `saga.workflow` reads Terraform's outputs (including the schema ID CSR assigned) and **appends them to two places as a single checkpoint**: Firestore's lineage log (a new event document — never an overwrite; the full deployment history accumulates here as immutable events) and a custom Entry in **Knowledge Catalog** (near-real-time — Google's own sync latency applies). The same step attaches the required `DataContract` Aspect, compiled from `contract/contract.yaml`, and syncs `contract/CONTRACT.md` to the Cloud Storage bucket. Then it marks the deployment as `deployed`.

**If this fails at any point:**

19. `saga.workflow`'s failure branch calls **`compensation.workflow`** (`orchestrator/compensation.workflow.yaml`) — a standalone GCP Workflows definition callable from more than one place (see Phase 6).
20. `compensation.workflow` triggers **`terraform-apply-job` again** — genuinely the same resource as step 14, not a new one — with an execution override pointing at the *previous* commit's SHA in `data-contracts/`. `contract-compiler` regenerates vars from that older contract state, and `terraform apply` runs again. Terraform's own diff computes exactly what needs to be undone, with no hand-written per-resource-type deletion code.
21. Only if that revert apply succeeds does `compensation.workflow` call **`git-revert.workflow`** (`orchestrator/revert/git-revert.workflow.yaml`), which pushes a `git revert` commit — never a force-push — to `data-contracts/` main via a scoped bot identity, re-aligning the declared contract with the infrastructure state that was actually restored.
22. If the revert apply itself fails, nothing touches git. The deployment is left in a flagged, human-escalation state rather than letting the repo claim a state that doesn't match reality.

---

## Phase 6 — Reconcile (runs on its own clock, independent of everything above)

23. Once an hour, **Cloud Scheduler** (`infra/scheduler.tf`) fires, calling the **`/reconcile` route** — again, the same `provisioning-api` service as `/ci` and `/cd`.
24. `/reconcile` runs `terraform plan` for each producer and checks for a non-empty diff. This catches what Phase 5's own failure handling structurally can't: a Workflows execution killed before it reached its own failure branch, a compensation call that itself failed, or someone changing something in Confluent Cloud's console directly, outside the platform entirely.
25. Any drift found calls the **same `compensation.workflow`** from step 19 — one place that knows how to undo, reached from two different triggers.

---

## Firestore — where the two halves of this story meet

Everything from step 18 onward appends to **Firestore** (`infra/firestore.tf`) as immutable event documents. Everything from Phase 7 onward only ever *reads* from it. No service in Phases 1–6 ever calls a service in Phases 7–8 directly — Firestore is the sole connection point, and it's one-directional: written by the control plane, read by what follows.

---

## Phase 7 — Hot path (continuous, running the whole time, unrelated to any PR)

This has been happening in parallel this entire time, for every producer whose contract was ever successfully deployed — it doesn't wait for or depend on any of the phases above being "in progress." There are two ingestion paths, declared by the producer in Phase 1. Both converge on the same Kafka topic.

**Dataflow pull path:**

26. The **Dataflow job** (`pull-ingestion-pipeline/`) holds one persistent streaming-pull connection to the producer's source topic — opened once at startup, not reopened per message. The source hands it new messages continuously as they arrive. The job loads the producer's proto descriptor from Firestore at startup and keeps it current via a background listener — no per-message Firestore read.

27. For each message, the job validates the payload via dynamic protobuf reflection against the cached descriptor. Invalid messages go to a dead-letter topic rather than being dropped silently. Valid messages are wrapped in the Confluent wire format and **produced directly to the internal Kafka topic**. If the payload doesn't match the declared schema, the producer discovers this via the dead-letter topic — not synchronously.

**REST publisher path:**

28. The producer's application sends `POST /v1/publish/{producer_route}` to the **`rest-publisher`** Cloud Run service with a Bearer token. `rest-publisher` resolves the route to a schema descriptor from its own in-process cache (same Firestore listener pattern as the Dataflow job — populated at startup, kept current in the background, zero Firestore reads per request). The payload is validated synchronously: a schema mismatch returns a `400` with a structured field-level error immediately, before anything touches Kafka. A valid payload is wrapped in the Confluent wire format and produced to the same internal Kafka topic. The service returns `200` with the Kafka offset once the broker acknowledges.

**From the Kafka topic onward, both paths are identical:**

29. **Simultaneously and continuously**, the **Confluent managed sink connector** provisioned back in Phase 5 relays every message landing on the Kafka topic into whichever `storage_target` the producer declared in `egress.yaml`. If no managed connector covers that target, the **Dataflow relay job** (`egress-fanout-pipeline/`) takes its place. Either way, nothing in this platform's own code triggers this per message.

30. Once data lands in egress storage, **Knowledge Catalog picks it up automatically** — BigQuery and Bigtable are natively auto-discovered sources, so this closes the loop back to the catalog with zero code written by this platform, unlike the custom Entry write Phase 5 needed for the Kafka/schema side.

31. Not one call in this entire phase touches GCP Workflows or `provisioning-api`. The only runtime dependencies are the producer's source (for the Dataflow path), Firestore (schema descriptor cache, read once at startup), and the Kafka cluster (writes). The control plane is completely out of the picture.

---

## Phase 8 — Data producer portal (contract authoring, deployment status, ongoing health)

The portal is both where this journey starts (Phase 1) and where the producer returns throughout. Three surfaces, one authenticated home dashboard.

**Contract authoring** — the home dashboard shows every contract the producer owns, scoped to their SSO identity, with a status badge and last-active metrics for each. A **New contract** button opens the authoring form described in Phase 1. An **Edit** button on any existing contract opens the same form pre-filled with the current values read from Firestore — submitting an edit runs the identical validate → generate → commit → PR sequence. The producer never touches git.

**Deployment status** — the moment `contract-api` opens the PR (end of Phase 1), the portal's deployment status view for that producer is already active, showing a pending state from the Firestore event written in step 2e. As Phase 3 CI runs, the plan result surfaces here before the PR is even merged. Once the saga starts:

32. `portal/frontend` polls `portal/backend`'s `status-api/` every 2–3 seconds while the saga is active, rendering each Firestore checkpoint as it completes — the same events `saga.workflow` was already writing, now displayed live. The producer watches "topic provisioned → schema registered → connector created → Dataflow job launched → deployed" tick through in near-real-time without leaving the portal.
33. Once the deployment reaches a terminal state, polling slows to every 30–60 seconds and the page keeps working as an ongoing health view. **Full deployment history** is always available — every prior deploy, compensation event, and revert scrolls back in the same view, sourced from the append-only Firestore lineage log.

**Ongoing metrics** — once deployed, `portal/backend`'s `metrics-client/` queries **Confluent Cloud's own Metrics API** for topic-level produce rate and last-message timestamp. Deployment success proves infrastructure exists; the metrics view proves data is actually moving. This answers the question "is my pipeline healthy right now" without touching the hot path at all.

34. The status view links directly to this producer's **Data Product page in Knowledge Catalog** — one click from operational status to what a consumer would see when browsing.

---

## Phase 9 — A consumer discovers, requests, and uses this data (separate from any producer's submission)

This phase runs on its own timeline, independent of everything above — it can happen the day after Phase 5 completes, or a year later.

35. A consumer browses **Knowledge Catalog's Data Products** page (or the open-source reference UI Google publishes for this), finds `orders-team`'s data product, and picks an **access group** — the specific consumption pattern that fits their use case: direct access, a new Kafka topic, a new Pub/Sub subscription, or a GraphQL API. This is their choice, not something `orders-team` decided when they filled out the portal form in Phase 1.
36. They submit the request with a justification. Knowledge Catalog routes it to the data product's configured approvers and tracks its status natively — no custom approval workflow was built for this.
37. The approver (someone on `orders-team`) approves it. The consumer gets an email notification.
38. **What happens next depends on which access group they picked:**
    - **Direct access** — Knowledge Catalog's own backend provisions the IAM grant on the existing BigQuery/Bigtable resource directly. Because that grant lives inside a GCP-native resource Knowledge Catalog already governs, **no additional write-back is needed** — this is the one pattern where "who currently has access" was already a solved problem before this platform existed. The consumer queries BigQuery or Bigtable directly with their own standard tooling.
    - **New Kafka topic or Pub/Sub subscription** — a listener detects the approval and triggers `terraform-apply-job` with the `kafka-mirror` or `pubsub-subscription` submodule, creating both the new topic/subscription and an `egress-fanout-pipeline` Dataflow relay job scoped to this one grant. Because this access exists outside anything Knowledge Catalog can see on its own, this same step **writes an access record back to Knowledge Catalog** — otherwise "who has access to this data" would quietly stop being answerable for that pattern. The consumer reads from their provisioned topic or subscription with their own standard client.
    - **GraphQL API** — the same trigger applies the GraphQL submodule, provisioning a new API endpoint scoped to this grant, and writes an access record back to Knowledge Catalog for the same reason. The consumer queries via their own HTTP client.
39. The consumer uses their newly provisioned access with their own standard tooling — no platform-specific integration code in any of the three patterns.
40. If access is later revoked, the same reconciliation removes whatever step 38 created — the topic, the Dataflow relay job, the GraphQL endpoint, and (for the patterns that needed one) the Knowledge Catalog access record — the same way removing any other declared resource would. Nothing about this phase ever touches git.

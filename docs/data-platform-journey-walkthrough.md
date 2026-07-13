# The Data Platform Journey — Step by Step

This document follows one thing happening: a producer changes their data contract and that change ends up flowing all the way to a published Kafka message, and separately, how a consumer finds and consumes that data afterward. It's organized in the exact sequence things actually happen, in nine phases — not by component, but by time.

---

## Phase 1 — Local machine

Nothing in this phase touches GCP. It all happens on the producer's own laptop.

1. A producer runs **`datapltfm init`** (`cli/cmd/init.go`) in a fresh repo. It fetches the latest proto templates and config schemas from the platform's central registry and scaffolds the following:

   ```
   .dataplatform/
   ├── schema/
   │   └── orders.proto          — empty message template, producer fills in fields
   ├── ingestion/
   │   └── ingestion.yaml         — push or pull config, see below
   └── egress/
       └── egress.yaml            — storage target + consumption interface, see below
   ```

   Nothing is filled in yet — these are templates. Here's exactly what a producer edits in each, and why each field exists:

   **`schema/orders.proto`** — ordinary `.proto` syntax, the actual message definitions this producer will publish. Nothing platform-specific here; it's what `datapltfm validate` lints and what CSR checks for compatibility later.

   **`ingestion/ingestion.yaml`** — one of two shapes, depending on `method`:

   ```yaml
   # push
   method: push
   producer_route: orders-created        # this producer's identifier on the gateway
   service_account: orders-team-sa@...   # will be granted run.invoker on the
                                          # gateway — never direct Kafka access
   ```

   ```yaml
   # pull
   method: pull
   producer_route: orders-created
   source:
     type: api_endpoint                  # or pubsub_topic, etc.
     url: https://legacy-orders.internal/export
   credentials: projects/x/secrets/orders-source-key   # Secret Manager
                                                          # reference only —
                                                          # a literal value here
                                                          # fails validation
   poll_interval: 30s
   ```

   Pull additionally provisions the Dataflow job from Phase 5, step 18 — the producer never manages that themselves, it's declared here and the platform handles the rest.

   **`egress/egress.yaml`** — only where this producer's data lands, nothing about how it gets consumed:

   ```yaml
   storage_target: bigquery                # or pubsub_topic, bigtable, alloydb,
                                            # firestore, cloud_storage, kafka_topic
   config:
     dataset: orders_analytics
     table: orders_created
     partition_column: created_at
     clustering_keys: [customer_id]
   ```

   The exact fields inside `config` vary by `storage_target` — a Bigtable choice asks for instance/table/row-key design instead of partition columns, for instance. This is the file `contract-compiler` (§2 of the architecture document) reads at CD time to decide what Terraform resources to generate. Notice there's no `consumption_interface` field here anymore — a producer only declares *where* their data lands. *How* any given consumer reads it — direct access, a dedicated Kafka topic, a REST API — is decided per-consumer, at access-request time, described in Phase 9.

2. The producer edits these three files in their own IDE, filling in the templates above with their actual schema, ingestion method, and egress choice.
3. The producer runs **`datapltfm validate`** (`cli/cmd/validate.go`) as often as they like. This imports `shared/validation-lib` and `shared/policy-bundles` directly — the exact same compiled code that will run server-side later, not a reimplementation — and catches proto lint errors, schema compatibility problems, and policy violations (like a literal credential where a Secret Manager reference belongs) before anything is ever committed.

Nothing here has created, changed, or even read anything in GCP yet.

---

## Phase 2 — Git / GitHub

4. The producer commits and pushes a branch, opening a **pull request**.
5. GitHub triggers the reusable **CI Actions** workflow (`.github/workflows/producer-ci.yml`), authenticating via Workload Identity Federation — no stored secret, just a short-lived token traded for GitHub's own OIDC identity.

---

## Phase 3 — CI: plan only (server-side, read-only)

Everything from here on runs in GCP — but nothing in this phase can mutate anything.

6. CI Actions calls the **`/ci` route** on `provisioning-api` (`provisioning-api/routes/ci.go`) — one Cloud Run service, first of its four routes to appear in this journey.
7. `/ci` runs validation and policy checks, then triggers **`terraform-plan-job`**, a Cloud Run Job built from `terraform-job/`, running under a service account that can only read.
8. Inside the Job, `entrypoint.sh` checks out the PR's commit, runs `contract-compiler` to turn `.dataplatform/` into `terraform.tfvars.json`, then runs `terraform plan` against the producer's isolated state.
9. `terraform plan` queries **Confluent Cloud and the relevant Google Cloud APIs read-only** to compute the diff — it creates, modifies, or deletes nothing. This is enforced by the Job's service account permissions, not just by convention.
10. `/ci` formats that plan and **posts it as a comment on the PR** — this is the same compatibility check Confluent Schema Registry will enforce for real at merge time, not a separate approximation of it.

---

## Phase 4 — Merge

11. A human reviewer reads the plan, checks the diff makes sense, and **approves and merges** the PR.
12. GitHub triggers the reusable **CD Actions** workflow (`.github/workflows/producer-cd.yml`).

---

## Phase 5 — CD: apply (the saga)

13. CD Actions calls the **`/cd` route** — the *same* `provisioning-api` service as `/ci`, same deploy, same service account.
14. `/cd` starts an execution of **`saga.workflow`** (`orchestrator/saga.workflow.yaml`), a GCP Workflows definition, and returns immediately with an execution ID rather than holding the connection open.
15. `saga.workflow` triggers **`terraform-apply-job`** — the same container image as the plan Job, but a separate Cloud Run Job resource running under a *write-scoped* service account, deliberately not run inline inside `provisioning-api` itself (five separate reasons for that, covering timeout limits, instance churn, IAM separation, blast radius, and resource sizing — see §5 of the architecture document).
16. Inside the Job: checkout the merge commit → `contract-compiler` → `terraform apply` against the producer's isolated state.

**If this succeeds:**

17. Terraform's Confluent and Google providers actually **create or modify the real resources** — the Kafka topic, the schema registration, IAM grants, and a **Confluent managed sink connector** (BigQuery Sink V2, BigTable Sink, etc.) that continuously moves data from the internal topic into whatever `egress.yaml` declared. No custom pipeline for this — it's a fully-managed connector, provisioned as one more resource in the same module.
18. **If `.dataplatform/ingestion/` declares `method: pull`**, this same apply also provisions a **Dataflow job** from `pull-ingestion-pipeline/`'s Flex Template — one conditional resource inside the same shared Terraform module, not a separate mechanism. `contract-compiler` already emitted the pipeline's launch parameters (source config, schema version, target route) into the same `terraform.tfvars.json` used for everything else in this apply.
19. `saga.workflow` reads Terraform's outputs (including the schema ID CSR assigned) and **writes them to two places**: Firestore (real-time, as before) and a custom Entry in **Knowledge Catalog** (near-real-time — Google's own sync latency applies, not something this platform controls). Same checkpoint, two writes, no new trigger. Then it marks the deployment as `deployed`.

**If this fails at any point:**

20. `saga.workflow`'s failure branch calls **`compensation.workflow`** (`orchestrator/compensation.workflow.yaml`) — a standalone GCP Workflows definition, not buried inside the saga, specifically so it can be called from more than one place (see Phase 6).
21. `compensation.workflow` triggers **`terraform-apply-job` again** — genuinely the same resource as step 15, not a new one — but with an execution override pointing at the *previous* commit's SHA. `contract-compiler` regenerates vars from that older contract state, and `terraform apply` runs again. Terraform's own diff computes exactly what needs to be undone — including tearing down the Dataflow job from step 18 if this PR was what introduced it, with no hand-written per-resource-type deletion code.
22. Only if that revert apply succeeds does `compensation.workflow` call **`git-revert.workflow`** (`orchestrator/revert/git-revert.workflow.yaml`), which pushes a `git revert` commit — never a force-push — to main via a scoped bot identity, re-aligning the declared contract with the infrastructure state that was actually restored.
23. If the revert apply itself fails, nothing touches git. The deployment is left in a flagged, human-escalation state rather than letting the repo claim a state that doesn't match reality.

---

## Phase 6 — Reconcile (runs on its own clock, independent of everything above)

24. Once an hour, **Cloud Scheduler** (`infra/scheduler.tf`) fires, calling the **`/reconcile` route** — again, the same `provisioning-api` service as `/ci` and `/cd`.
25. `/reconcile` runs `terraform plan` for each producer and checks for a non-empty diff. This catches what Phase 5's own failure handling structurally can't: a Workflows execution killed before it reached its own failure branch, a compensation call that itself failed, or someone changing something in Confluent Cloud's console directly, outside the platform entirely.
26. Any drift found calls the **same `compensation.workflow`** from step 20 — one place that knows how to undo, reached from two different triggers.

---

## Firestore — where the two halves of this story meet

Everything from step 19 onward writes to **Firestore** (`infra/firestore.tf`). Everything from Phase 7 onward only ever *reads* from it. No service in Phases 1–6 ever calls a service in Phases 7–8 directly — Firestore is the sole connection point, and it's one-directional: written by the control plane, read by what follows.

---

## Phase 7 — Hot path (continuous, running the whole time, unrelated to any PR)

This has been happening in parallel this entire time, for every producer whose contract was ever successfully deployed — it doesn't wait for or depend on any of the phases above being "in progress." There are two possible entry points into this phase, depending on what the contract declared back in Phase 1 — but only one gateway, unaware of which one it's talking to.

27. **`ingestion-gateway`** (a separate Cloud Run service, its own deploy pipeline) keeps an in-memory cache, hydrated once at each instance's startup from Firestore and kept current afterward by a realtime listener — this is how it learns about the schema Phase 5 just wrote, with zero polling.

**Push producers:**

28a. The producer's own application calls the gateway's single generic `Publish(producer_route, schema_version, bytes)` RPC directly.

**Pull producers:**

28b. Instead, the **Dataflow job** provisioned in step 18 continuously pulls from the declared source, serializes each record into the producer's schema using the same dynamic protobuf construction technique the gateway itself uses (built against a descriptor fetched from Firestore), and calls the identical `Publish` RPC with the result. The gateway's code path from here is unchanged either way — it has no way to tell whether the caller is a producer's own app or a platform-provisioned pipeline, and doesn't need to.

29. The gateway validates the raw bytes against the cached descriptor via dynamic protobuf reflection, wraps them in the Confluent wire format, and **produces directly to the Kafka topic**.
30. **Simultaneously and continuously**, the **Confluent managed sink connector** provisioned back in Phase 5 relays every message landing on that topic into whichever `storage_target` the producer declared in `egress.yaml` — BigQuery, Bigtable, or otherwise. Nothing in this platform's own code triggers this per message; it's the connector's own ongoing operation, running for as long as the deployment exists, entirely independent of anything in this phase's other steps.
31. Once data lands in that egress storage, **Knowledge Catalog picks it up automatically too** — BigQuery and Bigtable are both natively auto-discovered sources (architecture document, §14), so this closes the loop back to the catalog with zero code written by this platform, unlike the custom Entry write Phase 5 needed for the Kafka/schema side.
32. Not one call in this entire phase touches Firestore, Confluent Cloud's API, GCP Workflows, or `provisioning-api`. Every piece of information needed was already sitting in local memory.

---

## Phase 8 — Portal (home dashboard, search, available any time)

This is where the producer actually watches all of the above happen, and keeps coming back to.

33. The moment the PR merges (end of Phase 4), the producer opens the portal's **home dashboard** (`/`) — the page they actually bookmarked, not a specific producer's URL. It lists producer data contracts with a search box.
34. They search their `producer_id`, or just a memorable name if they don't recall the exact ID, and select their result. The frontend navigates client-side to that producer's live status view.
35. While the saga from Phase 5 is actively running, `portal/frontend` polls `portal/backend`'s status endpoint every 2–3 seconds, rendering each step as it completes — sourced from the same Firestore checkpoints `saga.workflow` was already writing at every step, not a new data source.
36. Once the deployment reaches a terminal state, polling slows to every 30–60 seconds, and the page keeps working as an ongoing health view — the producer returns any time by going back to the home dashboard and searching again, not by remembering a URL.
37. **Deployment success alone doesn't prove data is flowing**, and the portal treats that as a separate claim: `portal/backend`'s `metrics-client/` queries **Confluent Cloud's own Metrics API** for topic-level produce rate and last-message timestamp — using a read-only key, with zero changes to the gateway's hot path — and shows the producer real, ongoing evidence that their data is actually moving, whether it arrived via Phase 7's push or pull path.
38. **The portal never writes anything.** There is no wizard, no PR creation, no path back into Phase 2 from here. Every request this phase makes, from the home dashboard search to the metrics query, is a read.

---

## Phase 9 — A consumer discovers, requests, and uses this data (separate from any producer's PR)

This phase runs on its own timeline, independent of everything above — it can happen the day after Phase 5 completes, or a year later.

39. A consumer browses **Knowledge Catalog's Data Products** page (or the open-source reference UI Google publishes for this), finds `orders-team`'s data product, and picks an **access group** — the specific consumption pattern that fits their use case: direct access, a dedicated Kafka topic, or a REST API. This is their choice, not something `orders-team` decided when they wrote `egress.yaml` back in Phase 1.
40. They submit the request with a justification. Knowledge Catalog routes it to the data product's configured approvers and tracks its status natively — no custom approval workflow was built for this.
41. The approver (someone on `orders-team`) approves it. The consumer gets an email notification.
42. **What happens next depends on which access group they picked** — and specifically, whether Knowledge Catalog can already answer "who has access" on its own:
    - **Direct access** — Knowledge Catalog's own backend provisions the IAM grant on the existing BigQuery/Bigtable resource directly, and because that grant lives inside a GCP-native resource Knowledge Catalog already governs, **no additional write-back is needed** — this is the one pattern where "who currently has access" was already a solved problem before this platform existed.
    - **New Kafka topic or Pub/Sub subscription** — a listener detects the approval (Kafka is external to GCP, so this isn't auto-provisioned) and triggers `terraform-apply-job` with the `kafka-mirror` or `pubsub-subscription` submodule, creating both the new topic/subscription and an `egress-fanout-pipeline` Dataflow job that relays data into it, scoped to this one grant. Because this access exists entirely outside anything Knowledge Catalog can see on its own, this same step also **writes an access record back to Knowledge Catalog** — otherwise "who has access to this data" would quietly stop being answerable the moment a consumption pattern wasn't GCP-native.
    - **REST API** — the same trigger applies the `rest-api` submodule, which writes exactly one Firestore document describing the grant. No code deploys, no new route — `egress-api`'s single generic route already exists and starts answering `403` differently the moment that document exists. Like the Kafka/Pub/Sub case, this also writes a record back to Knowledge Catalog for the same reason.
43. The approval email links to the **access portal** (`access-portal/frontend/`) — a separate frontend from the producer-facing portal in Phase 8, since the audience here is a consumer, not a producer watching their own deployment. That page calls `egress-api`'s discovery endpoint live and renders the result as documentation — table names, real columns (traced, ultimately, all the way back to `orders-team`'s original `.proto` file from Phase 1), and ready-to-copy `curl` examples with their actual producer ID and table names already filled in. A machine-readable `openapi.json` is available at the same base path for anyone who wants to plug this into their own tooling instead.
44. The consumer calls `GET /v1/orders-team/order_items?customer_id=123&limit=50`. `egress-api`'s one generic handler resolves their identity from the token, checks the Firestore grant from step 42, checks BigQuery's live schema for `order_items`'s real columns, builds a parameterized query, and returns JSON.
45. If access is later revoked, the same reconciliation removes whatever step 42 created — the topic, the Dataflow job, the Firestore route document, and (for the two patterns that needed one) the Knowledge Catalog access record — the same way removing any other declared resource would. Nothing about this phase ever touches git.




# Data Platform Architecture

A self-service data platform combining a UI-driven contract authoring portal, a platform-owned git monorepo as the single source of truth for all contracts, a thin control-plane API, GCP Workflows for orchestration, and Terraform as the sole creator of producer infrastructure — with a separate always-on hot path that publishes data without ever depending on the control plane at request time.

Every numbered section below covers what the component is, how it works, and its concrete advantages — the chosen design, stated directly. Every place a real alternative was seriously weighed against that choice, the comparison lives in the **FAQ** at the end of this document, organized by the section it relates to, so the main narrative stays focused on how the platform actually works today.

## Implementation tiers

| Tier | Priority | Components |
|---|---|---|
| **`T1`** | Build first — core data path | Dataflow ingestion job, REST publisher, Kafka topic, Managed connector (egress), Egress storage, Dataflow job provisioned |
| **`T2`** | Build second — engineering automation | Portal (contract authoring + deployment status + metrics), GitHub Actions on platform contracts repo, CI plan (provisioning-api + terraform-plan-job), CD apply (provisioning-api + saga.workflow + terraform-apply-job), Cloud Scheduler + reconcile, Firestore (lineage store + schema cache), Dataflow relay, New Kafka / Pub/Sub / GraphQL consumption patterns, Federated producer route |
| **`T3`** | Build last — power-user tooling and discovery | CLI (local validation only), Confluent + Google providers (read-only), Knowledge Catalog, Browse/request/approval flow, Direct access pattern |

---

## Repository structure

```
data-platform/                          (platform monorepo)
├── cli/
│   └── cmd/
│       └── validate.go                  datapltfm validate — local validation only,
│                                        optional for engineers who prefer IDE feedback
│
├── shared/
│   ├── validation-lib/                  proto lint, schema compat, config schema
│   ├── policy-bundles/                  OPA/Rego rules
│   └── contract-compiler/               .dataplatform/ → terraform.tfvars.json
│
├── provisioning-api/                    Cloud Run service (REST/JSON)
│   └── routes/
│       ├── ci.go                        dry-run plan, posts status to portal
│       ├── cd.go                        starts saga.workflow
│       ├── jobs.go                      polled for status
│       └── reconcile.go                 terraform plan diff, drift → compensation
│
├── orchestrator/                        GCP Workflows definitions
│   ├── saga.workflow.yaml
│   ├── compensation.workflow.yaml
│   └── revert/
│       └── git-revert.workflow.yaml
│
├── terraform-job/                       Cloud Run Job container image
│   ├── Dockerfile
│   └── entrypoint.sh                    checkout → contract-compiler → terraform
│
├── pull-ingestion-pipeline/             Apache Beam (Java), Dataflow Flex Template
│   ├── src/                             streaming pull from producer's topic,
│   │                                    validate, wrap Confluent wire format,
│   │                                    produce directly to Kafka
│   └── template/                        Flex Template Dockerfile + spec
│
├── rest-publisher/                      Cloud Run service (Go) — alternative ingestion path
│   ├── publish.go                       POST /v1/publish/{producer_route}
│   ├── validate/                        dynamic protobuf validation (same logic as pipeline)
│   ├── wireformat/                      Confluent envelope construction
│   ├── cache/                           schema descriptor cache with Firestore listener
│   └── produce/                         Kafka producer
│
├── egress-fanout-pipeline/              Apache Beam (Java), Dataflow Flex Template
│   ├── src/                             relay from egress storage into a
│   │                                    consumer-specific topic/subscription
│   └── template/
│
├── portal/
│   ├── frontend/                        React + TypeScript, Vite build → static bundle
│   │   ├── src/pages/home-dashboard/    producer's contracts list + status overview
│   │   ├── src/pages/contract-create/   guided UI: schema fields, ingestion method,
│   │   │                                egress target, SLA commitments
│   │   ├── src/pages/contract-edit/     modify an existing contract (same form, pre-filled)
│   │   └── src/pages/deployment-status/ live step-by-step view + lineage history + metrics
│   └── backend/
│       ├── contract-api/                write path — validates, commits to data-contracts/,
│       │                                opens PR via GitHub API, returns PR URL to frontend
│       ├── status-api/                  reads Firestore lineage log, list/search, history
│       └── metrics-client/              reads Confluent Cloud Metrics API
│
├── infra/                               Terraform, platform's own resources
│   ├── firestore.tf
│   ├── secret-manager.tf                includes read-only Confluent metrics key,
│   │                                    GitHub App credentials for contract-api
│   ├── iam.tf                           WIF pool/provider, per-service roles
│   ├── cloud-run.tf
│   ├── scheduler.tf
│   ├── kafka-cluster.tf                 Confluent Cloud references
│   └── modules/
│       ├── producer-contract/           Confluent + Google providers, sink connectors,
│       │                                pull subscription + Dataflow job per producer
│       ├── federated-contract/          Knowledge Catalog entry only — no Kafka topic,
│       │                                no Dataflow job; data stays in producer's project
│       └── consumption-patterns/        applied on access-grant approval, not on merge
│           ├── direct-access/           IAM grant — GCP-native or cross-project
│           ├── kafka-mirror/            connector where available, else egress-fanout-pipeline
│           └── pubsub-subscription/     connector or new subscription, else egress-fanout-pipeline
│
└── .github/workflows/
    ├── provisioning-api-deploy.yml
    ├── rest-publisher-deploy.yml
    ├── orchestrator-deploy.yml
    ├── terraform-job-deploy.yml
    ├── pull-ingestion-pipeline-deploy.yml
    ├── portal-deploy.yml
    ├── infra-plan-apply.yml
    └── cli-release.yml                  optional; ships datapltfm validate binary

data-contracts/                         (platform-owned monorepo, separate repo)
  producers/
  └── {producer_id}/
      └── .dataplatform/
          ├── schema/orders.proto         generated and committed by portal/contract-api
          ├── ingestion/ingestion.yaml
          ├── egress/egress.yaml
          └── contract/
              ├── contract.yaml
              └── CONTRACT.md
  .github/workflows/
  ├── ci.yml                             triggers provisioning-api /ci on every PR
  └── cd.yml                             triggers provisioning-api /cd on merge to main
```

---

## Language and framework choices

| Component | Language / framework | Why |
|---|---|---|
| `cli/` | Go + Cobra | `datapltfm validate` only — single static binary, no runtime dependency on arbitrary laptops. Optional; engineers who prefer local feedback before opening the portal can install it. |
| `provisioning-api/` | Go, plain `net/http` | Cold-start matters — this is scale-to-zero. Also keeps one language across this service and the portal backend. See the FAQ for the general Go-vs-Spring-Boot reasoning behind every Cloud Run component here. |
| `portal/backend/contract-api/` | Go | Same cold-start and language-consistency reasoning. Handles form submission, runs `shared/validation-lib`, generates contract files, commits to `data-contracts/` via GitHub API, opens PR. Thin orchestration layer — no business logic that isn't also in `shared/`. |
| `terraform-job/` | Bash entrypoint + Terraform (HCL) | The job is "checkout, compile, run terraform" — a shell script calling three CLIs. No application logic here that would justify a general-purpose language. |
| `pull-ingestion-pipeline/` | **Java**, Apache Beam | Dataflow's Java SDK is meaningfully more mature for streaming workloads — richer source connectors, stronger windowing/state support. The pipeline is also where all message-level validation, wire-format construction, and Kafka producing now live. |
| `rest-publisher/` | Go, plain `net/http` | Same cold-start and language-consistency reasoning as `provisioning-api`. Shares the schema-descriptor cache pattern with `pull-ingestion-pipeline` but implemented in Go since this is a Cloud Run service, not a Dataflow pipeline. |
| `egress-fanout-pipeline/` | **Java**, Apache Beam | Same reasoning as `pull-ingestion-pipeline` — genuinely the same technology, running in the opposite direction (out of egress storage, into a consumer-specific topic or subscription, instead of into the platform). |
| `shared/validation-lib`, `shared/policy-bundles`, `shared/contract-compiler` | Go (lib/policy), Rego (policy rules) | Go so they compile directly into the CLI and portal backend as imports, not subprocess calls — see §8. |
| `portal/frontend/` | React + TypeScript, built with Vite | A client-side SPA calling a REST API is the simplest thing that works for an internal, authenticated tool — no SEO requirement that would justify a server-rendering framework like Next.js. |
| `portal/backend/` | Go | Thin service with three distinct jobs: contract authoring (write path), deployment status (read), and metrics (read). |
| `orchestrator/` | GCP Workflows YAML | Not a general-purpose language by design. |
| `infra/` | Terraform (HCL) | |

---

## 1. Terraform as infrastructure (`infra/` — platform infra, distinct from producer-contract Terraform)

**Two separate Terraform layers, deliberately not merged:**
- `infra/` — the platform's own resources (Firestore, IAM/WIF, Secret Manager, every Cloud Run service, Cloud Scheduler). Runs rarely, platform-team-driven.
- The shared producer-contract module (§5) — runs frequently, once per producer PR, with state isolated per producer.

**Advantages:** `terraform show`/`plan` gives an inspectable, authoritative record of what actually exists, for both layers, without any custom state-tracking code; blast-radius isolation between a platform-infra change and any single producer's deployment.

---

## 2. CLI (`cli/`) — **`T3`**

**What it is:** `datapltfm validate` — a local validation tool for engineers who want schema lint, compatibility checks, and policy enforcement in their terminal or editor before touching the portal. It is no longer the primary entry point for creating or modifying data contracts; the portal is. The CLI ships as an optional convenience, not a required part of any producer's workflow.

**Language and framework:** Go, using Cobra for subcommands and shell completion.

**How it works:** `validate` (`cli/cmd/validate.go`) runs `shared/validation-lib` and `shared/policy-bundles` against a local `.dataplatform/` directory. A producer can export their current contract files from the portal, run local validation, and re-submit via the portal — or skip the CLI entirely. It statically links `validation-lib` as an imported Go package, so local lint behavior is byte-for-byte identical to what `contract-api` runs server-side on submission.

**What it no longer does:** `datapltfm init` and `datapltfm update` are retired. Contract scaffolding happens through the portal's guided form. There are no per-producer repos to scaffold into, and no CI/CD workflow files to install — all of that now lives in `data-contracts/` under the platform team's control.

**Advantages:**
- Compiles to a single static binary per OS/architecture — no runtime dependency, no version-matching issues.
- `shared/validation-lib` compiles in as a direct import — zero risk of the CLI's validation logic diverging from what the portal runs on submission.
- Distributed via GitHub Releases or `go install` — no package registry to operate.

---

## 3. GitHub Actions (`.github/workflows/`) — **`T2`**

**What it is:** Two distinct sets of workflows, in two distinct repos.

**In `data-platform/` (platform team's own repo):** path-filtered deploy workflows, one per component — `portal-deploy.yml`, `provisioning-api-deploy.yml`, etc. These run when the platform team ships a new version of any platform service. No producer ever touches these.

**In `data-contracts/` (platform-owned contracts monorepo):** two workflows that drive the CI/CD lifecycle for every data contract in the system:
- `ci.yml` — triggers on every PR to `data-contracts/`. Calls `provisioning-api`'s `/ci` route for the changed producer path(s), which runs validation and a plan-only Terraform run. Posts the plan result back to the PR as a status check — producers see this result in the portal's deployment status view, not in a GitHub PR they need to navigate to separately.
- `cd.yml` — triggers on merge to main. Calls `provisioning-api`'s `/cd` route to start the saga.

**What changed from the per-producer-repo model:** the reusable `producer-ci.yml` and `producer-cd.yml` workflows that producer repos previously referenced are gone. Every contract now lives in `data-contracts/`, and GitHub Actions in that one repo handle CI/CD for all of them. A platform-team change to CI/CD behavior is still a single-file edit — but now it's in `data-contracts/.github/workflows/` rather than the platform monorepo, and it applies to every contract simultaneously.

**Advantages:** One repo, one set of CI/CD workflows, zero per-producer workflow maintenance; producers never see or manage a GitHub Actions file; the platform team owns the entire contract lifecycle end-to-end.

---

## 4. Provisioning API (`provisioning-api/`) — **`T2`**

**What it is:** One Cloud Run service, four routes: `/ci`, `/cd`, `/jobs`, `/reconcile`.

**How it works:** `/ci` runs validation and policy checks, then triggers a plan-only run of the same Cloud Run Job used for apply (see §5), so CI and CD provably run identical logic. `/cd` starts a GCP Workflows saga execution. `/jobs` is polled for status. `/reconcile` is called by Cloud Scheduler and diffs live state against declared state, invoking compensation on drift.

**Advantages:** Permission brokering — external callers only ever need permission to call this one API, not every internal resource; fails fast and cheaply, rejecting malformed requests before a Workflows execution or Job run starts; insulates producer repos from internal changes like renaming a workflow or swapping the execution engine; shapes responses for direct use in a PR comment or the portal, instead of Workflows' generic execution-status JSON; a natural home for policy that doesn't belong in Terraform or Workflows — concurrency limits, freeze windows, rejecting unregistered producer IDs.

---

## 5. Terraform execution — Cloud Run Jobs (`terraform-job/`) — **`T2`** plan · **`T1`** apply

**What it is:** One container image, built from `terraform-job/Dockerfile` + `terraform-job/entrypoint.sh`, containing `git`, `terraform`, and the `contract-compiler` binary — deployed as two distinct Cloud Run Job resources, since a Job's service account is fixed per-resource and plan needs read-only while apply needs write:

- **`terraform-plan-job`** **`T2`** — read-only service account. Used by `/ci`.
- **`terraform-apply-job`** **`T1`** — write-scoped service account. Used by `/cd`'s forward apply, and reused for revert with an execution-time override pointing at the previous commit's SHA instead of the merge SHA — not a third Job resource.

**How it works:** `entrypoint.sh` checks out the producer repo at a given SHA → runs `contract-compiler` to generate `terraform.tfvars.json` → runs `terraform plan` (`terraform-plan-job`) or `terraform apply` (`terraform-apply-job`) against that producer's isolated Terraform state (a GCS backend with a per-producer key prefix). Both Jobs reference the same shared Terraform module, `infra/modules/producer-contract/`, which wraps the Confluent provider (topic, schema, connector resources) and the Google provider (BigQuery/Bigtable/AlloyDB/Firestore/GCS depending on the producer's chosen egress target, plus IAM bindings).

**A deliberate carve-out:** a naive revert-apply would try to delete a Confluent schema version if the previous config no longer declares it. The shared module sets `lifecycle { prevent_destroy = true }` on the schema resource specifically, so Terraform refuses that particular destroy.

**Advantages:** Revert is symmetric with forward apply — no bespoke undo code per resource type; `terraform plan` becomes a genuine drift detector for §7; adding a new egress storage type is a module change, not new orchestration code; IAM separation between plan and apply is enforced structurally, not by convention.

---

## 6. Orchestrator — GCP Workflows (`orchestrator/`) — **`T2`**

**What it is:** `saga.workflow.yaml`, `compensation.workflow.yaml`, `revert/git-revert.workflow.yaml`.

**How it works:** `saga.workflow`'s entire job is to trigger the Terraform-executing Cloud Run Job (§5), poll it, and branch. On success, it reads the Job's Terraform outputs (e.g., the assigned schema ID) and writes them to Firestore. On failure, it calls `compensation.workflow`, which triggers a second Job run — checking out the previous commit, regenerating vars from that older contract state, and applying — letting Terraform's own diff compute the revert. Only if that succeeds does `git-revert.workflow` push a revert commit to main.

**Advantages:** Durable, resumable execution with native retry/branching, built by Google rather than hand-maintained; compensation logic is one generic "re-apply an earlier commit's vars" operation, not custom per-resource-type code; execution state — which step a saga is on, what the last Job's outcome was — persists independent of any compute instance's lifetime.

---

## 7. Cloud Scheduler + `/reconcile` — **`T2`**

**How it works:** Hourly trigger → `/reconcile` runs `terraform plan` per producer and checks for a non-empty diff. A non-empty diff invokes `compensation.workflow` — the same one the saga's own failure branch uses.

**Advantages:** `terraform plan` is the actual source of truth for drift — no separately-maintained diffing logic to keep in sync with what Terraform manages.

---

## 8. Shared libraries (`shared/`) — **`T2`**

### `validation-lib`
Proto lint, schema compatibility checks (calls Confluent Schema Registry's compatibility endpoint), and config-schema validation. Imported by the CLI (locally), by `provisioning-api` (server-side), and invoked as a standalone binary inside the Cloud Run Job that runs Terraform.

### `policy-bundles`
OPA/Rego rules — e.g., ingestion credentials must reference Secret Manager, never a literal value. Checked wherever `validation-lib` runs.

### `contract-compiler`
A CLI that reads `.dataplatform/{schema,ingestion,egress,contract}` at a given commit and emits `terraform.tfvars.json`, matching the shared Terraform module's variable schema. This is the piece that turns a producer's declared intent into Terraform's language.

**Advantages:** One codebase for each concern, consumed identically everywhere it's needed; policy and compiler logic version and release independently of any single service's deploy cadence.

### Which components use which library

| Library | Used by | How |
|---|---|---|
| `validation-lib` | `cli/` (`datapltfm validate`) | Imported as a Go package — proto lint, schema compat, config schema checks, run locally before commit |
| `validation-lib` | `provisioning-api/routes/{ci,cd}.go` | Imported as a Go package — the same checks, run server-side before a Job is ever triggered |
| `validation-lib` | `terraform-job/entrypoint.sh` | Invoked as a standalone compiled binary — a defense-in-depth re-check immediately before `terraform plan`/`apply`, in case something reached this point without going through `/ci` or `/cd` |
| `policy-bundles` | Same three components as `validation-lib` | Checked at the same points, alongside it |
| `contract-compiler` | `terraform-job/entrypoint.sh` only | Invoked as a standalone binary — turns the checked-out `.dataplatform/` into `terraform.tfvars.json`. Not used by the CLI or `provisioning-api` directly; generating Terraform variables is specifically a CI/CD-time operation |

---

## 9. Ingestion — two paths to the same Kafka topic — **`T1`**

**Every producer's data arrives in the internal Kafka topic through one of two paths: a Dataflow streaming pull job (the default for high-throughput producers who own a source topic) or the REST publisher (for producers who want synchronous HTTP delivery and immediate schema validation feedback).** Both paths converge on the same validate → Confluent wire format → Kafka produce sequence, and both use the same schema descriptor cache backed by Firestore (§11). The choice is declared in `ingestion.yaml` and determines what `terraform-apply-job` provisions at CD time.

### 9a. Dataflow pull path (`pull-ingestion-pipeline/`) — **`T1`**

**Two prerequisites, stated explicitly, that a producer must satisfy before onboarding on this path — the platform cannot create either on their behalf:**

1. **A Kafka or Pub/Sub topic must already exist**, owned and operated by the producer. This is not something `terraform-apply-job` provisions — it's infrastructure the producer brings to the relationship.
2. **The producer must grant the platform's designated service account read access to that topic** — a Pub/Sub IAM binding or a Kafka ACL, done on the producer's own side, before their PR can successfully apply. Terraform can create a subscription against an existing topic; it cannot reach into a producer's project or cluster and grant itself access it wasn't given.

**How it works, end to end:**

1. `ingestion/ingestion.yaml` declares `method: pull` and a `source` — `type: kafka_topic` or `type: pubsub_topic`, plus connection details and a Secret Manager credential reference (never a literal value).
2. At CD apply time, `terraform-apply-job` provisions a pull subscription (Pub/Sub) or consumer group (Kafka) against the producer's existing topic, and a Dataflow job from the same generic, parameterized Beam pipeline template — one template serving every producer through runtime parameters.
3. That Dataflow job holds one persistent streaming-pull connection to the producer's topic. The job opens the connection once and the source hands it new messages continuously as they arrive, with no per-message reconnect.
4. For each message, the pipeline validates the payload via dynamic protobuf reflection against the descriptor held in its in-process cache (populated at startup from Firestore, kept current by a background listener — see §11). Invalid messages are routed to a dead-letter topic rather than dropped silently.
5. Validated messages are wrapped in the Confluent wire format (schema ID header + serialized protobuf bytes) and produced directly to the internal Kafka topic using a Confluent Kafka producer configured with the cluster credentials from Secret Manager.

**IAM:** the Dataflow job's service account holds Kafka produce credentials (from Secret Manager) and Firestore read access. No producer-side identity ever touches the internal Kafka cluster.

**A deliberate carve-out:** teardown uses Dataflow's `on_delete = "drain"` rather than cancel, so in-flight pulled data finishes processing rather than being dropped mid-record.

**The one honest cost of this path:** schema validation is asynchronous from the producer's perspective. A producer publishing to their own topic gets no immediate feedback if their payload doesn't match the schema — the dead-letter topic surfaces the failure, but not synchronously. Producers who need synchronous validation feedback should use the REST publisher path instead.

**Advantages:** Zero producer-side integration code; one pipeline template scales to every producer through parameters; no separate service to deploy, scale, or operate on the hot path; Confluent Kafka credentials stay inside the platform's own Dataflow service account, never exposed to producer-side identities.

---

### 9b. REST publisher (`rest-publisher/` — Cloud Run service, Go) — **`T1`**

**What it is:** A Cloud Run service that accepts authenticated HTTP POST requests carrying a single event payload and returns a synchronous confirmation — or a synchronous schema validation error. It is an alternative ingestion path for producers who already have HTTP client infrastructure, want immediate schema feedback, or are publishing at rates where a persistent streaming-pull connection is unnecessary overhead.

**When to use this path vs. the Dataflow path:** the Dataflow pull path is the better fit for sustained high-throughput producers (sub-millisecond message intervals) because it amortizes connection cost across continuous delivery. The REST publisher is the better fit for lower-frequency producers, event-driven publishers, or any producer where the synchronous reject-on-bad-schema behavior is operationally valuable. Both paths are available to every producer — the choice is a single field in `ingestion.yaml`.

**How it works:**

1. `ingestion/ingestion.yaml` declares `method: rest`. At CD apply time, `terraform-apply-job` grants the producer's declared service account `roles/run.invoker` on the `rest-publisher` Cloud Run service — no Dataflow job is provisioned for this producer.
2. The producer's application sends `POST /v1/publish/{producer_route}` with an `Authorization: Bearer` token and a protobuf or JSON body. The platform-issued token is exchanged via Workload Identity; no API key is distributed.
3. `rest-publisher` resolves the `producer_route` to a cached schema descriptor (same Firestore listener mechanism as the Dataflow pipeline — loaded at instance startup, updated in the background, never fetched per request).
4. The payload is validated via dynamic protobuf reflection against that descriptor. If validation fails, the service returns a `400` with a structured error describing the field-level mismatch — synchronously, before anything reaches Kafka.
5. A valid payload is wrapped in the Confluent wire format and produced to the internal Kafka topic. The service returns `200` with the assigned Kafka offset once the broker acknowledges.

**Schema validation is synchronous here** — the key behavioral difference from the Dataflow path. A producer gets an immediate, actionable error if their payload doesn't match the declared schema, rather than discovering it later via the dead-letter topic.

**IAM:** `roles/run.invoker` is granted only to the specific service account the producer declared in their `ingestion.yaml`. The service itself holds Kafka produce credentials via Secret Manager — no producer-side identity ever sees them.

**Advantages:** Synchronous schema validation feedback; no prerequisite source topic for the producer to manage; natural fit for HTTP-native publishers; shares the same descriptor cache and Confluent wire-format logic as the Dataflow path, so there is no behavioral divergence between the two paths once a message is accepted.

---

## 10. Kafka — Confluent Cloud — **`T1`** topic + managed connector + egress storage

**What it is:** The internal streaming backbone every producer's data lands in via `pull-ingestion-pipeline`, regardless of what egress target that producer eventually chose. This is a narrower decision than it might look — Pub/Sub is already available as one of the egress storage targets a producer can pick for their own consumption pattern (alongside BigQuery, Bigtable, AlloyDB, Firestore, Cloud Storage). What's being decided here is only what the platform itself runs underneath every producer before that choice ever comes into play.

**How it works:** Both created and read through the Confluent Terraform provider. Schema compatibility (`BACKWARD`, etc.) is enforced by CSR itself — the same check `/ci`'s plan-only Job run surfaces to a PR reviewer is the exact check that gates the real apply.

**Worth being precise about:** Kafka brokers never validate anything against Schema Registry — a broker just stores whatever bytes it's given. Schema Registry integration is entirely client-side. The pipeline's dynamic validation step (§9), immediately before the produce call, is the only schema check anywhere in this hot path — the Confluent wire-format wrapping that follows it is metadata embedded purely for whichever consumer reads the message later.

**Advantages:** Spec-compliant wire format means any downstream consumer can use off-the-shelf Confluent deserializers with zero custom code; the log/replay model matches the platform's actual job (fan-out to many independent, possibly-later-arriving consumers) more closely than a queue does. Full comparison against Google Cloud Pub/Sub as an alternative backbone is in the FAQ.

### How a producer's declared egress gets populated

`egress.yaml`'s `storage_target` (BigQuery, Bigtable, etc.) needs something to continuously move data from the internal topic into that storage. This is not a custom pipeline — Confluent Cloud ships 100+ fully-managed Kafka Connect sink connectors (`T1`), confirmed available for BigQuery (the V2 connector, using BigQuery's Storage Write API) and BigTable specifically, with Cloud Storage and Pub/Sub sinks very likely covered too. `infra/modules/producer-contract/` provisions the appropriate `confluent_connector` resource — one more resource in the same module that already creates the topic and schema, via the same `terraform-apply-job`.

Where no managed connector exists for a given target (possibly AlloyDB or Firestore, worth confirming at build time), the module falls back to the **`T2`** Dataflow relay pattern described in §14.

---

## 11. Firestore — **`T2`**

**How it works — two distinct document collections, one database:**

**Deployment lineage log (`deployments/{producer_id}/events/{event_id}`):** every saga checkpoint is appended as a new document — never overwritten. A deploy start, each provisioning step, a success, a compensation trigger, a revert — each is a separate timestamped document. The current state of a producer's deployment is always the latest event in their subcollection; full history is always queryable without any custom versioning scheme. The portal's `status-api` reads this subcollection to render both the live step-by-step view during an active deployment and the full deployment history a producer can scroll back through.

**Schema descriptor mirror (`schemas/{producer_id}/versions/{schema_id}`):** every schema version that CSR assigns is written as a separate document at the same saga checkpoint. The `pull-ingestion-pipeline` and `rest-publisher` both load the latest descriptor at startup from this collection and keep it current via a Firestore realtime listener — no per-message Firestore read, no polling interval. When a producer ships a new schema version, the saga writes it here, and the listener pushes the update to every running pipeline and publisher instance within seconds, without a redeploy.

**Why the hot path never reads Firestore per message:** both the Dataflow pipeline and the REST publisher maintain an in-process schema descriptor cache, populated at startup and updated by the background listener. A message arriving on the hot path finds the descriptor already in memory — the Firestore read already happened, asynchronously, when the schema was first deployed or last updated. This gives the hot path zero external calls per message while staying current within the listener's propagation window (typically under 5 seconds).

**Advantages:** append-only deployment events give full lineage with no custom versioning code — the entire history is always there, including every compensation and revert; the background listener pattern removes Firestore from the per-message hot path entirely; serverless, no capacity planning for what is genuinely low, bursty write volume.

---

## 12. Data Producer Portal — **`T2`**

**What it is:** The primary interface for data producers — a single destination for creating and modifying data contracts, watching deployments happen live, and confirming that data is actually flowing. It now has a write path: the portal is where contracts are born and updated, not a downstream observer of work done elsewhere. Every producer, regardless of git experience, has a complete self-service on-ramp through this UI.

**The portal has three distinct surfaces, accessible from the same authenticated home dashboard:**

---

### Contract authoring (write path)

A guided multi-step form where a producer defines their data contract without touching a file or a terminal. The form covers every field that previously lived in `.dataplatform/`:

- **Schema definition** — a form-based protobuf message builder: add fields, set types, mark optional/required. Produces a valid `.proto` file; the producer never writes protobuf syntax directly.
- **Ingestion configuration** — choose Dataflow pull (with source topic details and credential reference) or REST publisher; federated producers declare their existing GCP resource here instead.
- **Egress target** — pick a storage target from a dropdown; the form adapts to show only the relevant config fields for that target (BigQuery shows dataset/table/partition, Bigtable shows instance/table/row-key design, etc.).
- **SLA commitments** — structured fields for `freshness_sla_minutes`, `uptime_commitment_pct`, `breaking_change_notice_days`, `support_contact`, and an optional free-text `CONTRACT.md` editor.

On submission, `portal/backend/contract-api/` does the following in sequence:

1. Runs `shared/validation-lib` and `shared/policy-bundles` on the generated contract — the same validation that CI runs, before anything reaches git. Returns field-level errors immediately if validation fails, so the producer fixes them in the form before a commit is ever made.
2. Generates the canonical contract files (`schema/orders.proto`, `ingestion/ingestion.yaml`, `egress/egress.yaml`, `contract/contract.yaml`, `contract/CONTRACT.md`) via `shared/contract-compiler`.
3. Commits those files to `data-contracts/producers/{producer_id}/.dataplatform/` via the GitHub API, using a platform-managed GitHub App credential stored in Secret Manager.
4. Opens a pull request against `data-contracts/` main branch and returns the PR details to the frontend.
5. Writes a pending deployment event to Firestore so the portal's deployment status view immediately reflects the in-progress state.

**For contract modifications:** the portal's edit page pre-fills the same form with the current values read from Firestore (the latest deployed contract state). Submitting an edit goes through the identical sequence above — validation, file generation, commit, PR. The producer sees a diff summary of what changed before confirming the submission.

**PR review and the platform team's role:** the PR that `contract-api` opens is reviewable by the platform team (or auto-approved based on configurable policy — e.g., schema-compatible changes with no egress target change merge automatically; breaking changes or new federated source declarations require a human review). This is where the platform team retains governance over what enters the contracts monorepo, without requiring producers to understand git.

---

### Deployment status and history (read path)

The same deployment monitoring that existed before, now directly connected to the contract the producer just submitted:

- **Live step-by-step saga view** — polls `portal/backend/status-api/` every 2–3 seconds while a deployment is active, rendering each saga checkpoint as it completes. The plan result from CI is shown here before the PR merges, so the producer sees what will change before it does.
- **Full deployment history** — reads the append-only Firestore lineage log for this producer, showing every prior deployment, compensation, and revert with timestamps and outcomes. A producer can see the complete history of their contract without leaving the portal.
- **Live metrics** — once deployed, `portal/backend/metrics-client/` queries Confluent Cloud's Metrics API for produce rate and last-message timestamp. Deployment success proves infrastructure exists; this proves data is moving.
- **Link to Knowledge Catalog** — one click from the deployment status view to the producer's Data Product page in Knowledge Catalog, so they can confirm what a consumer will see.

---

### Home dashboard

The page producers bookmark. Shows every contract they own (scoped to their SSO identity), with a status badge (deploying / deployed / failed / compensation-in-progress) and last-active metrics for each. Search matches on `producer_id` or human-readable name. Selecting a contract navigates to its deployment status view. A "New contract" button opens the authoring form.

---

**`portal/backend`** is one Cloud Run service with three distinct jobs:

- **`contract-api/`** — the write path. Validates submitted forms, generates contract files, commits to `data-contracts/` via GitHub API, returns PR details and initial status. This is the only component in the entire system that writes to `data-contracts/` on a producer's behalf.
- **`status-api/`** — reads Firestore's deployment lineage log; powers the live step view, history, and home dashboard status badges.
- **`metrics-client/`** — queries Confluent Cloud's Metrics API using a read-only scoped key.

**Auth:** portal access goes through the org's existing SSO. All three backend jobs scope their responses to what the authenticated user's team owns — including the home dashboard search, which only ever returns contracts the requester is allowed to see. `contract-api` additionally verifies that the submitting user is authorized to create or modify a contract for the declared `producer_id`.

**`portal/frontend`** is a React + TypeScript SPA, built with Vite into static files served from Cloud Storage + CDN. "Static" describes how the app shell is delivered — the JavaScript running in the browser makes live calls to `portal/backend` for all data and all mutations.

**Advantages:** every producer, regardless of git experience, has a complete self-service on-ramp; all contracts are platform-governed from creation, not just from the first CI run; the platform team retains PR-level review without requiring producers to learn git; one system of record (`data-contracts/`) for all contracts, owned and auditable by the platform team; the authoring and monitoring experience are the same tool, so producers naturally check deployment status and metrics as part of creating a contract rather than hunting for a separate URL.

---

## 13. Knowledge Catalog — **`T3`**

**What it is:** An org-wide, searchable catalog of every data element the platform ingests — schema history, storage location, active consumption patterns, and current access — combined with the consumer-facing browse-and-request-access experience built directly on top of it. That experience is also what decides *how* a specific consumer gets to read a producer's data, deliberately not decided by the producer upfront.

**Naming note:** the original standalone Data Catalog product was deprecated and shut down in 2026 — do not build against it. Dataplex Universal Catalog was itself renamed Knowledge Catalog (APIs, `gcloud dataplex` commands, and client libraries kept their original names — only the product branding changed). Knowledge Catalog is what this section describes.

**How it works — cataloging:**
- Knowledge Catalog auto-discovers BigQuery, Cloud SQL, Spanner, Pub/Sub, AlloyDB, Cloud Storage, and Dataproc natively. It does not auto-discover Confluent Cloud, since Kafka isn't a GCP resource. Every producer's schema/topic is registered as a custom Entry by `saga.workflow`, at the same checkpoint that already writes to Firestore on a successful apply.
- **The egress side closes this loop for free, on the GCP-native path.** Once the Confluent managed connector (§10) lands data in the producer's declared `storage_target` — BigQuery or Bigtable — Knowledge Catalog's native auto-discovery picks that resource up automatically, with zero code written by this platform.
- **Real-time is not achievable through Knowledge Catalog itself, and this is a Google platform constraint, not a design choice.** Documented sync latency: metadata/entries up to ~10 minutes, lineage graphs 30 minutes to 3 hours. Firestore remains the genuinely real-time operational record the portal depends on; Knowledge Catalog is a deliberately separate, near-real-time governance and discovery layer.
- Lineage for the pull path is picked up automatically, since Dataflow lineage tracking is GA.
- **The object model, precisely:** an Entry is the canonical pointer to a data asset. An Entry Type can require specific Aspects before an Entry counts as complete. An Aspect Type is a schema-enforced template (typed fields — string, number, boolean, enum, nested records, not a free-form JSON blob); an Aspect is one filled-in instance of that template, attached to an Entry.
- **This is where SLA and scope commitments live, as a first-class part of the model.** A custom `DataContract` Aspect Type — `freshness_sla_minutes`, `uptime_commitment_pct`, `breaking_change_notice_days`, `support_contact` — gets attached to every producer's Entry, compiled from `.dataplatform/contract.yaml` and written by `saga.workflow` at the same checkpoint as everything else. Making it a required Aspect via the Entry Type turns "producer states their commitments" into something enforced, not optional documentation. All fields are typed and independently searchable.
- **Aspects don't support file attachments.** The `DataContract` Aspect includes a `full_contract_document_url` field pointing at a longer-form `CONTRACT.md` that the producer writes and versions in git alongside their schema, synced to a Cloud Storage bucket by the same saga step. The structured fields carry the queryable, enforceable numbers; the linked document carries fuller written context.

**How it works — the consumer experience:**

Everything a consumer does, from discovery through gaining access, happens in Google's own console — nothing in this platform's own codebase renders any of it. A consumer browses Knowledge Catalog's Data Products page, finds a producer's data product, and reads its description, documentation, and aspects — all populated from the custom Entry `saga.workflow` wrote at deploy time. The `DataContract` Aspect's four structured fields (`freshness_sla_minutes`, `uptime_commitment_pct`, etc.) render directly on the Data Product page alongside a link out to the full `CONTRACT.md` for anyone who wants complete written context. Optionally, an organization can stand up Google's open-source reference UI (`knowledge-catalog-business-user-interface`) as a more tailored front door to the same underlying API — still Google's design, just self-hosted and reskinned rather than built from scratch.

**How it works — access requests:**
- Each producer's egress target is registered as a Data Product in Knowledge Catalog, with owner/approver emails configured at creation.
- A consumer picks an access group — which represents a specific consumption pattern (direct access, or a dedicated Kafka topic/Pub/Sub subscription) — and submits a request with a justification. This is a native, built-in workflow. The request routes to the data product's configured approvers, who approve or reject; the consumer gets tracked status and an email notification.
- **On approval, provisioning branches by whether the target is GCP-native or not — and so does whether "who has access" needs any new bookkeeping.** For GCP-native resources (BigQuery, etc.), Knowledge Catalog's own backend provisions the IAM grant directly, and since that grant lives inside a resource Knowledge Catalog already governs, nothing further is needed. For Kafka-based patterns — not GCP-native, not visible to Knowledge Catalog on their own — a thin listener triggers the existing `terraform-apply-job`, applying the appropriate `infra/modules/consumption-patterns/` submodule for whichever access group was requested (§14), and that same step writes an access record back to Knowledge Catalog. Without this, "who currently has access to this data" would quietly stop being answerable for that pattern.
- **Revocation is symmetric with approval, not a separate mechanism.** An active grant is just a row in the desired-state config `terraform-apply-job` reconciles against; removing it on revocation triggers the same job to tear down whatever was created.

**Advantages:** Zero custom search, lineage-graphing, or approval-workflow code to build or maintain; one write, piggybacked on an existing checkpoint, populates an org-wide governance surface; a genuinely self-service discovery and request experience; GCP-native access targets provision themselves; the freshness mismatch between Firestore and Knowledge Catalog is stated plainly rather than implied to be seamless.

---

## 14. Consumer fan-out — **`T1`** managed connector · **`T2`** relay + new patterns

**What it is:** The mechanism behind the "new Kafka topic" and "new Pub/Sub subscription" consumption patterns (§13) — genuinely new infrastructure, provisioned per access grant, never speculatively. Three different mechanisms apply, tried in this order, depending on the producer's declared `storage_target` and what the consumer requested: no relay at all when the types already match, a Confluent managed connector where one exists, and a Dataflow relay for everything else.

**No relay needed at all, when the source already matches** **`T1`** **—** if the producer's `egress.yaml` declared `storage_target: pubsub_topic` and a consumer requests a new Pub/Sub subscription, provisioning is just a new subscription on the producer's *existing* topic — no new topic, no relay infrastructure, nothing to run continuously. The same logic applies, via Kafka's own cluster linking rather than a new subscription primitive, when both the source and the request are `kafka_topic`.

**Confluent Cloud managed connectors — `T1` — where available — listed exactly, not assumed:**

| Producer's `storage_target` | Consumer requests | Connector |
|---|---|---|
| `pubsub_topic` | New Kafka topic | Confluent's Google Cloud Pub/Sub **Source** connector (Pub/Sub → Kafka) |
| `kafka_topic` | New Pub/Sub subscription | Confluent's Google Cloud Pub/Sub **Sink** connector (Kafka → Pub/Sub) |
| `cloud_storage` | New Kafka topic | Confluent's Google Cloud Storage **Source** connector (GCS → Kafka) |

`infra/modules/consumption-patterns/kafka-mirror/` (or `pubsub-subscription/`) provisions the appropriate `confluent_connector` resource for these combinations — the same Terraform pattern already used for the producer's own sink connector in §10, applied by `terraform-apply-job` on approval, torn down on revocation.

**One BigQuery-specific option worth naming but not relying on as a default:** Confluent's Pub/Sub Source connector can also reach BigQuery data indirectly, via BigQuery's own Continuous Queries feature exporting to Pub/Sub first. This is a real, documented path, but it depends on setting up Continuous Queries as a separate BigQuery-side capability — more moving parts than a direct 1:1 connector, and not treated as the default here.

**Dataflow relay `T2` — the fallback for everything not covered above:** `bigquery`, `bigtable`, `alloydb`, and `firestore` as source `storage_target`s have no confirmed managed connector moving their data directly into Kafka or Pub/Sub. For these, the `egress-fanout-pipeline` Beam/Dataflow pattern applies — the same shape as `pull-ingestion-pipeline` (§9), running in the opposite direction, relaying from the producer's already-provisioned egress storage into a brand-new topic or subscription created specifically for one approved consumer.

**Advantages:** The cheapest possible path is always tried first — no relay, then a managed connector, only reaching for a custom pipeline when neither applies; lifecycle tied directly to the access grant that caused any of these to exist, torn down the same way regardless of which mechanism provisioned it.

---

## 15. Federated producer route — data stays in the producer's GCP project — **`T2`**

**What it is:** A contract path for producers who already have data stored in their own GCP project — a BigQuery dataset, a Cloud SQL instance, a Spanner database, a Cloud Storage bucket — and don't need (or want) the platform to ingest a copy into the internal Kafka topic. Instead of provisioning an ingestion pipeline, the platform registers a semantic model of that data in Knowledge Catalog, so consumers can discover it, understand it, and request access to it through the same catalog experience as any other data product. The data never moves. The platform brokers access to where it already lives.

**When to use this path:** a producer who manages a well-maintained BigQuery dataset that consumers should be able to query directly; a team with an existing Cloud SQL database that's already the authoritative source and copying it would create a stale, secondary replica; any case where the primary need is governed discoverability and controlled access, not a streaming pipeline.

**How it works — contract declaration:**

`ingestion/ingestion.yaml` declares `method: federated`, with a reference to the producer's existing GCP resource:

```yaml
method: federated
source:
  type: bigquery_dataset        # or cloud_sql, spanner_database, cloud_storage_bucket
  project: orders-team-prod
  dataset: orders_analytics     # bigquery_dataset only
```

No `source.topic_name`, no `credentials` field — the platform doesn't pull from this resource. What it does instead is described below.

**How it works — what the saga provisions:**

At CD apply time, `terraform-apply-job` runs the `infra/modules/federated-contract/` module instead of `producer-contract/`. This module does four things and only four things:

1. **Registers a Knowledge Catalog Entry** pointing at the producer's external resource — the same custom Entry shape and `DataContract` Aspect as a standard ingestion producer, so consumers see no difference in the catalog experience.
2. **Attaches schema metadata** compiled from `schema/orders.proto` (or a BigQuery schema export, if the producer declares `schema_source: bigquery` instead of a `.proto` file) as a Schema Aspect on the Entry.
3. **Writes a Firestore document** recording the federated source reference — used at access-grant time to know which project and resource to target when provisioning consumer access.
4. **Does not** create a Kafka topic, a Confluent schema registration, a Dataflow job, a pull subscription, or a managed connector. None of those exist for a federated producer.

**How it works — consumer access provisioning:**

When a consumer requests access via Knowledge Catalog and is approved, provisioning depends on which access pattern they chose:

- **Direct access** — `terraform-apply-job` applies a cross-project IAM binding in the producer's own GCP project: for example, `roles/bigquery.dataViewer` on the specific dataset, granted to the consumer's service account. The consumer queries BigQuery directly in the producer's project, using their own credentials. The platform provisions the binding and writes it back to Knowledge Catalog; it never touches the data itself.
- **New Kafka topic** — the platform provisions an `egress-fanout-pipeline` Dataflow job that reads from the federated source (BigQuery export, Cloud SQL CDC, etc.) and writes into a new platform-managed Kafka topic scoped to this consumer. The consumer reads from that topic with a standard Kafka client. The data is copied at this point — but only per consumer grant, not speculatively.
- **New Pub/Sub subscription** — same as above, but the fanout destination is a Pub/Sub topic rather than Kafka.

**What "cross-project IAM" actually requires:** the platform's `terraform-apply-job` service account must be granted `roles/resourcemanager.projectIamAdmin` (or a tighter custom role covering just the resource type being bound) in the producer's project. This is a one-time, per-producer-project prerequisite — documented in the contract onboarding checklist — analogous to the IAM binding a Dataflow-path producer grants for topic read access. Without it, the apply job cannot provision consumer grants into an external project.

**Schema source flexibility:** producers on the federated path can declare their schema as either a `.proto` file (same as standard ingestion, compiled by `contract-compiler`) or as `schema_source: bigquery`, which causes `contract-compiler` to call the BigQuery API at plan time and generate a proto-compatible representation of the live table schema automatically. This means a producer with an existing BigQuery table doesn't need to re-author their schema in protobuf — they get a catalog entry that reflects their actual columns.

**Advantages:** Governed discoverability for data that's already well-managed without requiring the producer to change how they store or publish it; cross-project IAM access provisioned the same way as everything else — through Terraform, through the same `terraform-apply-job`, torn down on revocation; consumers get the same Knowledge Catalog browse-and-request experience regardless of whether the data is on the platform's own Kafka topic or in an external GCP project.

**The honest constraints:** the platform cannot enforce schema validation for data written directly to an external BigQuery table — it can only describe what's there. If a producer's BigQuery schema drifts from the declared contract, the catalog entry becomes stale until the producer updates their PR. And cross-project IAM provisioning requires that initial `projectIamAdmin` grant in the producer's project, which some organizations' security posture may require a separate approval track for.

---

## FAQ

### 1. Should this Cloud Run service be Go, or something like Spring Boot?

This comes up for any of the Cloud Run services and jobs in this platform, not just one — the answer is the same reasoning applied consistently:

- **Cold start matters for anything scale-to-zero.** A Go binary starts in tens of milliseconds; a JVM-based service like Spring Boot takes seconds to start unless you invest in GraalVM native compilation, which adds real build complexity. For anything sitting on the hot path or fronting CI/CD latency, this is a concrete, immediate cost.
- **Fleet consistency.** Every Cloud Run component in this platform is Go. One language means one team, one dependency-update cadence, and an engineer can move between services without a context switch.
- **When Spring Boot would actually be the better call:** if the team's core strength were Java rather than Go, or if a given service were expected to grow a much heavier surface — complex auth integrations, ORM-heavy data access, dozens of endpoints — Spring's ecosystem maturity would start to outweigh Go's cold-start edge. Given the actual shape of these services today (thin routes that mostly delegate work to Terraform, Workflows, or Firestore), that ecosystem weight isn't buying much here. This is a right-tool-for-the-current-shape call, not a claim that Go is categorically better.

### 2. Why a platform-owned contracts monorepo instead of per-producer repos with a CLI? (§2, §3, §12)

The original design used a CLI (`datapltfm init`) to scaffold contract files into each producer team's own repo, with reusable CI/CD workflows the producer repo referenced. That design was replaced for three distinct reasons:

**First, producer accessibility.** Git and PR workflows are familiar to platform engineers but are a real barrier for data producers who aren't engineers — analysts, data stewards, domain owners who know their data but don't own a GitHub repo. A form in a browser is the right interface for declaring "my table has these columns, freshness SLA is 15 minutes, storage target is BigQuery." Forcing that through a `.proto` file and a git push wasn't serving them.

**Second, governance and consistency.** With contracts scattered across dozens of producer repos, each team controls their own CI/CD workflow file — meaning they could accidentally break or bypass it, reference a stale version of the platform's reusable workflow, or drift from whatever policy the platform team intended to enforce. In the platform-owned monorepo, there is exactly one CI/CD workflow for all contracts, owned by the platform team, updated once and applied everywhere. No producer can accidentally opt out of a policy check.

**Third, auditability.** "Which contracts exist, and what do they currently declare?" is answerable from a single repo rather than requiring a sweep across every producer team's codebase. The full git history of every contract change — who submitted it, when, what was reviewed — lives in one place under the platform team's control.

**What the per-producer-repo design gave for free, and how the new design matches it:**

| What the old design provided | How the new design provides the same |
|---|---|
| Full version history per contract | `data-contracts/` git history per `producers/{producer_id}/` path |
| PR review before apply | `contract-api` opens a PR; platform team reviews (or auto-approves per policy) |
| Rollback via `git revert` | Compensation workflow targets the previous commit in `data-contracts/` exactly as before |
| Validation before commit | `contract-api` runs `shared/validation-lib` before writing a single file to git |
| CI/CD separation (propose then apply) | `data-contracts/` CI workflow calls `/ci` on PR; `/cd` on merge — structurally identical |

The CLI (`datapltfm validate`) still exists for engineers who want a local feedback loop — but it's optional, not required, and has no `init` or `update` commands because there's nothing to scaffold into a producer repo anymore.

### 3. Why keep `provisioning-api` instead of having GitHub Actions call GCP Workflows or Cloud Scheduler directly? (§4)

- **Permission brokering.** The API's own service identity holds the real internal invoke permissions (`roles/workflows.invoker`, etc.). External callers (any producer repo, via a single shared, org-wide WIF identity) only ever need permission to call *the API* — not every internal resource the platform might grow to include. Without this layer, every new internal workflow or job means widening what the shared external identity can reach.
- **Fail fast, cheaply.** A malformed request or invalid config is rejected in milliseconds, before a Workflows execution or a Job run ever starts — keeping the execution history meaningful and avoiding wasted compute.
- **Insulation from internal change.** Renaming a workflow, splitting the saga, or swapping the execution engine is a server-side deploy, not a rollout that has to reach every producer repo.
- **Response shaping.** The API returns "here's what will change to your Kafka topic and schema," not Workflows' generic execution-status JSON.
- **A home for policy that doesn't belong in Terraform or Workflows** — concurrency limits, freeze windows, rejecting unregistered producer IDs.

Also considered: Cloud Functions instead of Cloud Run (lost on finer concurrency/startup control and consistency with the rest of the platform's services), and gRPC instead of REST (the caller is a `curl` step in CI YAML, so gRPC tooling would be pure friction for no benefit at this traffic volume).

### 4. Why does Terraform run in a dedicated Cloud Run Job instead of inline inside `provisioning-api`'s own handler? (§5)

Five separate reasons, not one:

1. **Request duration doesn't fit.** Cloud Run Services cap request duration (up to 60 minutes, still a hard ceiling) — built for request/response traffic, not long-running work. Cloud Run Jobs are a different product built specifically for run-to-completion workloads, with task timeouts up to 24 hours.
2. **Service instances get killed mid-request, routinely — Jobs are guaranteed to finish.** Cloud Run Service instances are recycled constantly (scale-down, every deploy, occasional host maintenance) with no awareness of whether a request is mid-flight. An instance killed halfway through a `terraform apply` leaves infrastructure partially applied with no clean signal about what happened.
3. **IAM separation requires two distinct resources.** A Cloud Run Service has exactly one service account for the whole service, shared across every request. Plan and apply run as two distinct Job resources with two distinct service accounts specifically so that "CI genuinely cannot mutate anything" is enforced by IAM, not convention.
4. **Blast radius.** Terraform provider plugins (Confluent's, Google's) are third-party code. A separate Job isolates a bad run to its own container, rather than risking the same process that's simultaneously handling every other producer's `/ci` requests and `/jobs` polling.
5. **Different resource profiles.** `provisioning-api`'s handlers are cheap; Terraform is heavier — provider binaries, in-memory state, large diffs. A dedicated Job resource is sized for exactly what it needs, independently.

Cloud Build was also considered — purpose-built for exactly this and a completely reasonable choice — but lost narrowly to Cloud Run Job for architectural consistency, since every other compute piece in this platform is already Cloud Run.

### 5. Why GCP Workflows instead of Cloud Composer, Cloud Tasks, or a hand-rolled state machine? (§6)

| Option | Why it lost |
|---|---|
| Cloud Composer / Airflow | Built for data-pipeline DAGs at a much heavier operational cost — a managed cluster, not serverless — for a workload that's a handful of executions a day. |
| Cloud Tasks | A simple queue, no native branching, retry-with-backoff, or try/except error handling. |
| Hand-rolled state machine inside `provisioning-api` | Execution state would live inside a Cloud Run instance's memory — and Cloud Run instances are recycled constantly, so a mid-saga instance death would lose track of where the saga was. |

This system actually has three distinct kinds of state, each owned by a different component: infrastructure state (owned by the Terraform state file, §5/§1), orchestration state — where a given saga run currently is, which step it's on, whether to proceed or compensate — and hot-path mirror data (owned by Firestore, §11). A Cloud Run Job is excellent at *executing* one bounded unit of work reliably, but has no facility for orchestration state — a Job execution is a container that starts, runs, exits, and retains nothing about itself once it exits. GCP Workflows fills exactly that gap: its execution persists as a durable, managed resource inside the Workflows service itself, independent of any container or compute instance, so a `try`/`except` block still knows exactly what state the saga was in when a Job fails, and that durability survives underlying infrastructure hiccups without hand-built checkpoint/resume logic.

### 6. Why hourly reconciliation instead of a continuous drift-detection stream? (§7)

A continuous stream (e.g., watching Confluent Cloud audit logs) was considered and rejected as significant added complexity for a failure mode — partial saga failure, or a manual out-of-band change — rare enough that an hourly check catches it well within an acceptable window.

### 7. Why Dataflow with streaming pull, instead of a Pub/Sub push subscription, the Beam Go SDK, or a bespoke pipeline per producer? (§9)

| Option | Why it lost |
|---|---|
| A Pub/Sub push subscription delivering straight to an HTTP endpoint | Push delivers one message per HTTP request with no batching on the delivery side — a real throughput ceiling well below the sub-millisecond-per-producer requirement this platform has to support. Streaming pull avoids this entirely: Dataflow opens one persistent connection and the source hands it messages continuously, with no per-message reconnect. |
| Beam Go SDK, to keep the whole platform in one language | Meaningfully less mature than Java's SDK for Dataflow specifically — fewer built-in source connectors, weaker windowing/state support. |
| A bespoke pipeline per producer | Same failure mode as a bespoke Terraform config per producer — every new producer would need someone to hand-write a new pipeline, defeating self-service. |
| Cloud Composer/Airflow scheduling periodic pulls | Batch-oriented and adds a managed-cluster operational cost for a job that's naturally a continuous streaming pull. |

### 8. Why Kafka over Google Cloud Pub/Sub as the internal backbone? (§10)

Self-hosted Kafka + Schema Registry was ruled out quickly, for operational cost — running and patching a cluster is a full-time concern this platform doesn't need to take on. Pub/Sub, as the internal backbone instead of Confluent Cloud, was a genuinely close call, not a lopsided one, and worth walking through in full.

**The core structural difference:** Pub/Sub has no equivalent to a Kafka partition. A Pub/Sub topic fans out to explicitly-created subscriptions, each an independent copy with its own acknowledgment tracking. Kafka instead retains one ordered, append-only log per partition, independent of who's reading it — any consumer group, including one created long after messages were published, reads that same log using its own independently tracked offset.

**Kafka over Pub/Sub, specifically for this role:**

- **Replay and retention work differently at the mechanical level.** A Pub/Sub subscription only receives messages published *after it was created*. Google's topic-level retention lets a newly-created subscription `seek()` back into a retained window, narrowing this gap — but it's an opt-in feature layered on top of the subscription model. In Kafka, the partition's retention window is simply a property of the topic itself; there's no "did a subscription exist yet" question for any consumer group. That matters directly here, since the platform is explicitly designed to fan one producer's stream out to consumers who may onboard well after the data was originally produced.
- **Ordering is structural in Kafka, opt-in in Pub/Sub.** Pub/Sub delivers messages unordered by default; enabling ordering caps throughput per key. Kafka's ordering falls directly out of a partition being an append-only log, with no configuration involved.
- **Ecosystem depth.** Pub/Sub Schemas (Avro/Protobuf) are real and convenient — validated server-side at publish time. But the feature is comparatively thin: no equivalent to CSR's `BACKWARD`/`FORWARD`/`FULL` compatibility modes enforced transitively across every prior version, no Kafka Connect-sized connector catalog, no ksqlDB-style stream processing built around it.
- **Cloud portability.** Kafka is an open, vendor-agnostic standard; Pub/Sub is GCP-proprietary. For something positioned as a foundational, org-wide platform, that's a real hedge against deeper GCP lock-in.

**Where Pub/Sub would genuinely have been the simpler choice:**

- **Native GCP IAM, mechanically simpler.** Pub/Sub access is granted with an ordinary `google_pubsub_topic_iam_member` Terraform resource — the exact same IAM pattern used for every other GCP resource in this system, authenticated automatically via Workload Identity. Confluent Cloud has its own entirely separate identity plane — API keys scoped per-cluster with their own ACL system, not GCP IAM at all. That's the direct, mechanical reason this design needs Secret Manager entries for Confluent credentials.
- **Zero cluster or capacity concept.** Fully serverless with no tier or sizing decision, and likely cheaper at low or bursty volume.
- **Tighter native GCP integration in places.** Direct Pub/Sub-to-BigQuery subscriptions, for instance, can skip a separate Dataflow job for some patterns.

### 9. Why Firestore instead of Bigtable or Cloud SQL/Postgres? (§11)

| Option | Why it lost |
|---|---|
| Bigtable | Built for a different scale/shape of problem (millions of QPS, wide-column) than low-volume platform metadata; its Change Streams don't offer the same simple SDK-level background listener the pipeline's schema cache depends on. |
| Cloud SQL / Postgres | Relational would model deployment records fine, but lacks a native push/listener mechanism — which is load-bearing for the hot-path cache design — and the append-only event log shape fits documents more naturally than a fixed relational schema anyway. |

### 10. Why build on Knowledge Catalog instead of a custom catalog, or treating Firestore as the catalog? (§13)

| Option | Why it lost |
|---|---|
| Build a custom catalog and access-request workflow from scratch | Would mean re-implementing search, lineage graphing, approval routing, and a governance UI — all of which Knowledge Catalog already provides natively. |
| Treat Firestore as the catalog | Firestore has no search, no lineage graph, no org-wide discovery UI, and no consumer-facing browse/request experience. It's the right tool for real-time operational state and append-only deployment logs; the wrong tool for organization-wide discovery. |

### 11. Why offer a REST publisher at all, when the Dataflow pull path already works? (§9b)

The Dataflow pull path has one structural limitation that's genuinely painful for some producers: schema validation is asynchronous. A message that doesn't match the declared schema surfaces in the dead-letter topic, not as an immediate error to the publisher. For producers building event-driven systems, or teams onboarding who want rapid feedback during development, that gap is real. The REST publisher closes it — a bad payload gets a `400` back before it ever touches Kafka. The two paths converge on identical behavior once a message is accepted, so there's no risk of behavioral divergence downstream.

### 12. Why prefer a managed connector over Dataflow for consumer fan-out, wherever one exists? (§14)

Less custom code to operate, and Confluent already handles connector-level scaling and retry. Dataflow remains necessary both for the combinations no connector covers, and structurally — a producer's own sink (§10) is fixed and always-on, while a consumer-requested relay needs an arbitrary source relaying into a destination created and destroyed per individual grant, a shape existing connectors aren't built for regardless of which storage type is involved.

---

## Design principles this all traces back to

| Principle | Where it shows up |
|---|---|
| One system of record | `data-contracts/` is the only place contracts are *declared*; `contract-api` is the only writer to it; Terraform state is the only place "what exists" is recorded |
| Control plane vs. hot path, strictly separated | Workflows/Terraform never appear on the publish path; Firestore is the only bridge |
| Revert is symmetric with create | Compensation is "apply the previous commit's generated vars," not bespoke undo code per resource |
| Least privilege by construction | Confluent Kafka credentials live only in the Dataflow/REST publisher service accounts; per-producer Terraform state prevents cross-producer blast radius; cross-project IAM grants are scoped to the specific resource, not the whole project |
| Fail fast, cheaply | `contract-api` runs full validation before committing a single file; `/ci` and the plan job reject bad input before any infrastructure is touched; the REST publisher rejects schema mismatches synchronously before anything reaches Kafka |
| Safety nets have their own safety nets | Saga compensation catches in-flight failures; `terraform plan`-based reconciliation catches everything the saga couldn't see happen |
| One generic mechanism, not one per producer | The Dataflow pipeline's single Beam template and the REST publisher's single route both serve every producer through runtime parameters, never a compiled-in, producer-specific path |
| Hot path reads nothing per message | Both ingestion paths (Dataflow and REST publisher) carry schema descriptors in an in-process cache backed by a Firestore listener — zero external calls at message time |
| Full lineage, never overwritten | Firestore deployment records are append-only events — the complete history of every deploy, compensation, and revert is always queryable without a custom versioning scheme |
| Data gravity respected | The federated producer route lets well-managed existing data stay where it is; the platform adds discoverability and access control without forcing a copy |
| Platform-governed, producer-accessible | All contracts live in a platform-owned monorepo the platform team controls end-to-end; producers interact through a form UI, not git — without sacrificing review, audit trail, or rollback |
| Not everything needs to go through git | Access grants deliberately don't — the right check for "should this consumer see this data" is a business decision made fast by an owner, not an engineering review of a diff |
| Be honest about a dependency's own limits | Firestore is genuinely real-time; Knowledge Catalog is not, and that's stated plainly rather than implied to be seamless |

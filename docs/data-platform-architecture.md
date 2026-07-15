# Data Platform Architecture

A self-service data platform combining git-reviewed contracts, a thin control-plane API, GCP Workflows for orchestration, and Terraform as the sole creator of producer infrastructure — with a separate always-on hot path that publishes data without ever depending on the control plane at request time.

Every numbered section below covers what the component is, how it works, and its concrete advantages — the chosen design, stated directly. Every place a real alternative was seriously weighed against that choice, the comparison lives in the **FAQ** at the end of this document, organized by the section it relates to, so the main narrative stays focused on how the platform actually works today.

## Implementation tiers

| Tier | Priority | Components |
|---|---|---|
| **`T1`** | Build first — core data path | Dataflow ingestion job, Kafka topic, Managed connector (egress), Egress storage, Dataflow job provisioned |
| **`T2`** | Build second — engineering automation | CLI, GitHub Actions, CI plan (provisioning-api + terraform-plan-job), CD apply (provisioning-api + saga.workflow + terraform-apply-job), Cloud Scheduler + reconcile, Firestore, Dataflow relay, New Kafka / Pub/Sub / GraphQL consumption patterns |
| **`T3`** | Build last — observability and discovery | Confluent + Google providers (read-only), Knowledge Catalog, Portal (frontend + backend), Browse/request/approval flow, Direct access pattern |

---

## Repository structure

```
data-platform/                          (platform monorepo)
├── cli/
│   └── cmd/
│       ├── init.go                      datapltfm init
│       ├── update.go                    datapltfm update
│       └── validate.go                  datapltfm validate
│
├── shared/
│   ├── validation-lib/                  proto lint, schema compat, config schema
│   ├── policy-bundles/                  OPA/Rego rules
│   └── contract-compiler/               .dataplatform/ → terraform.tfvars.json
│
├── provisioning-api/                    Cloud Run service (REST/JSON)
│   └── routes/
│       ├── ci.go                        dry-run plan, posts to PR
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
├── egress-fanout-pipeline/              Apache Beam (Java), Dataflow Flex Template
│   ├── src/                             relay from egress storage into a
│   │                                    consumer-specific topic/subscription
│   └── template/
│
├── portal/
│   ├── frontend/                        React + TypeScript, Vite build → static bundle
│   │   ├── src/pages/home-dashboard/    lists producers, search by id or name
│   │   └── src/pages/deployment-status/ live status for one producer, reached via search
│   └── backend/
│       ├── status-api/                  reads Firestore, list/search, per-producer status
│       └── metrics-client/              reads Confluent Cloud Metrics API
│
├── infra/                               Terraform, platform's own resources
│   ├── firestore.tf
│   ├── secret-manager.tf                includes read-only Confluent metrics key
│   ├── iam.tf                           WIF pool/provider, per-service roles
│   ├── cloud-run.tf
│   ├── scheduler.tf
│   ├── kafka-cluster.tf                 Confluent Cloud references
│   └── modules/
│       ├── producer-contract/           Confluent + Google providers, sink connectors,
│       │                                pull subscription + Dataflow job per producer
│       └── consumption-patterns/        applied on access-grant approval, not on merge
│           ├── direct-access/           just an IAM grant, no new resource
│           ├── kafka-mirror/            connector where available, else egress-fanout-pipeline
│           └── pubsub-subscription/     connector or new subscription, else egress-fanout-pipeline
│
└── .github/workflows/
    ├── cli-release.yml
    ├── provisioning-api-deploy.yml
    ├── orchestrator-deploy.yml
    ├── terraform-job-deploy.yml
    ├── pull-ingestion-pipeline-deploy.yml
    ├── portal-deploy.yml
    ├── infra-plan-apply.yml
    ├── producer-ci.yml                  reusable, called by every producer repo
    └── producer-cd.yml                   reusable, called by every producer repo

<team>-data-contract/                   (many, separate repos)
  .dataplatform/{schema,ingestion,egress,contract}/     contract.yaml holds SLA commitments, CONTRACT.md alongside it
  .github/workflows/ci.yml, cd.yml       reference producer-ci.yml / producer-cd.yml
```

---

## Language and framework choices

| Component | Language / framework | Why |
|---|---|---|
| `cli/` | Go + Cobra | Single static binary, no runtime dependency on arbitrary laptops. |
| `provisioning-api/` | Go, plain `net/http` | Cold-start matters — this is scale-to-zero. Also keeps one language across the CLI and this service. See the FAQ for the general Go-vs-Spring-Boot reasoning behind every Cloud Run component here. |
| `terraform-job/` | Bash entrypoint + Terraform (HCL) | The job is "checkout, compile, run terraform" — a shell script calling three CLIs. No application logic here that would justify a general-purpose language. |
| `pull-ingestion-pipeline/` | **Java**, Apache Beam | Dataflow's Java SDK is meaningfully more mature for streaming workloads — richer source connectors, stronger windowing/state support. The pipeline is also where all message-level validation, wire-format construction, and Kafka producing now live. |
| `egress-fanout-pipeline/` | **Java**, Apache Beam | Same reasoning as `pull-ingestion-pipeline` — genuinely the same technology, running in the opposite direction (out of egress storage, into a consumer-specific topic or subscription, instead of into the platform). |
| `shared/validation-lib`, `shared/policy-bundles`, `shared/contract-compiler` | Go (lib/policy), Rego (policy rules) | Go so they compile directly into the CLI and `provisioning-api` as imports, not subprocess calls — see §8. |
| `portal/frontend/` | React + TypeScript, built with Vite | A client-side SPA calling a REST API is the simplest thing that works for an internal, authenticated tool — no SEO requirement that would justify a server-rendering framework like Next.js. |
| `portal/backend/` | Go | Thin service, mostly delegating to Firestore reads and the Confluent Metrics API. |
| `orchestrator/` | GCP Workflows YAML | Not a general-purpose language by design. |
| `infra/` | Terraform (HCL) | |

---

## 1. Terraform as infrastructure (`infra/` — platform infra, distinct from producer-contract Terraform)

**Two separate Terraform layers, deliberately not merged:**
- `infra/` — the platform's own resources (Firestore, IAM/WIF, Secret Manager, every Cloud Run service, Cloud Scheduler). Runs rarely, platform-team-driven.
- The shared producer-contract module (§5) — runs frequently, once per producer PR, with state isolated per producer.

**Advantages:** `terraform show`/`plan` gives an inspectable, authoritative record of what actually exists, for both layers, without any custom state-tracking code; blast-radius isolation between a platform-infra change and any single producer's deployment.

---

## 2. CLI (`cli/`) — **`T2`**

**What it is:** `datapltfm init` / `datapltfm update` / `datapltfm validate` — scaffolds, refreshes, and locally validates `.dataplatform/` in a producer repo.

**Language and framework:** Go, using Cobra (the framework behind `kubectl`, `docker`, `gh`, and `helm`) for subcommands, flags, and shell completion.

**How it works:** `init` fetches the latest proto templates, config schemas, and CI/CD workflow templates from the platform's central registry and writes them into a new repo. `update` re-fetches later so a repo never drifts far from what the platform currently enforces. `validate` (`cli/cmd/validate.go`) runs `shared/validation-lib` and `shared/policy-bundles` against the working directory on demand, so a producer can re-check their contract after every edit, before ever committing. It statically links `validation-lib` as an imported Go package, so local lint behavior is byte-for-byte identical to what CI runs server-side.

**Advantages:**
- Compiles to a single static binary per OS/architecture — no runtime dependency, no version-matching issues on a developer's machine.
- Same language as `provisioning-api` — one team, one set of idioms, one dependency-update cadence to track.
- `shared/validation-lib` compiles into the CLI as a direct import, not a subprocess call — zero risk of the CLI's validation logic silently diverging from the server's.
- Distributed via GitHub Releases (cross-compiled per OS/arch) or `go install` for Go-native users — no package registry to operate.

---

## 3. GitHub Actions (`.github/workflows/`) — **`T2`**

**What it is:** Platform deploy workflows (path-filtered, one per component) and reusable workflows (`producer-ci.yml`, `producer-cd.yml`) referenced by every producer repo.

**Advantages:** A platform-team change to CI/CD behavior ships by editing one file; producer repos' own workflow files stay nearly static and need almost no maintenance, since all real logic lives server-side in `provisioning-api`.

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

## 9. Ingestion via Dataflow (`pull-ingestion-pipeline/`) — **`T1`**

**Every producer, without exception, is ingested the same way: they own a Kafka or Pub/Sub topic, and a per-producer Dataflow job pulls from it, validates each message, wraps it in the Confluent wire format, and produces directly to the internal Kafka topic.** There is no separate gateway service in this path — the pipeline owns the full journey from producer source to Kafka.

**Two prerequisites, stated explicitly, that a producer must satisfy before onboarding — the platform cannot create either on their behalf:**

1. **A Kafka or Pub/Sub topic must already exist**, owned and operated by the producer. This is not something `terraform-apply-job` provisions — it's infrastructure the producer brings to the relationship.
2. **The producer must grant the platform's designated service account read access to that topic** — a Pub/Sub IAM binding or a Kafka ACL, done on the producer's own side, before their PR can successfully apply. Terraform can create a subscription against an existing topic; it cannot reach into a producer's project or cluster and grant itself access it wasn't given.

**How it works, end to end:**

1. `ingestion/ingestion.yaml` declares a `source` — `type: kafka_topic` or `type: pubsub_topic`, plus connection details and a Secret Manager credential reference (never a literal value).
2. At CD apply time, `terraform-apply-job` provisions, for every producer without exception: a pull subscription (Pub/Sub) or consumer group (Kafka) against the producer's existing topic, and a Dataflow job from the same generic, parameterized Beam pipeline template — one template serving every producer through runtime parameters.
3. That Dataflow job holds one persistent streaming-pull connection to the producer's topic. The job opens the connection once and the source hands it new messages continuously as they arrive, with no per-message reconnect.
4. For each message, the pipeline validates the payload via dynamic protobuf reflection against a descriptor fetched from Firestore at startup and refreshed via a background listener — no per-message Firestore call. Invalid messages are routed to a dead-letter topic rather than dropped silently.
5. Validated messages are wrapped in the Confluent wire format (schema ID header + serialized protobuf bytes) using the schema ID written to Firestore by the saga at deploy time.
6. The pipeline produces directly to the internal Kafka topic using a Confluent Kafka producer configured with the cluster credentials from Secret Manager.

**IAM:** the Dataflow job's service account holds Kafka produce credentials (from Secret Manager) and Firestore read access. No producer-side identity ever touches the internal Kafka cluster.

**A deliberate carve-out:** teardown uses Dataflow's `on_delete = "drain"` rather than cancel, so in-flight pulled data finishes processing rather than being dropped mid-record.

**The one honest cost of this design:** schema validation is asynchronous from the producer's perspective. A producer publishing to their own topic gets no immediate feedback if their payload doesn't match the schema — the dead-letter topic surfaces the failure, but not synchronously. This is a real, uncovered gap and a candidate for future work if it proves painful in practice.

**Advantages:** Zero producer-side integration code, for any producer, of any sophistication level; one pipeline template scales to every producer through parameters; no separate service to deploy, scale, or operate on the hot path; Confluent Kafka credentials stay inside the platform's own Dataflow service account, never exposed to producer-side identities.

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

**How it works:** Holds deployment/saga-log records and a mirror of CSR (`subject → schema_id → descriptor`), written by the saga once Terraform apply succeeds. The `pull-ingestion-pipeline` fetches this descriptor at Dataflow job startup and refreshes it via a background listener, giving it the schema information it needs for validation and wire-format construction with no per-message external call.

**Advantages:** Background listener keeps the pipeline's schema view current without polling; serverless, no capacity planning for what is genuinely low, bursty write volume.

---

## 12. Data Producer Observability Portal — **`T3`**

**What it is:** A fully read-only status and monitoring UI, entered through a home dashboard rather than a deep link — not a second control plane. This is producer-facing only — it serves the team that owns a data contract, watching their own deployment. Its only job is to let a producer see what's happening to their data, from the moment they merge a PR through however long that pipeline keeps running afterward. There is no write path anywhere in it.

**How it works:**

`portal/frontend` is a React + TypeScript SPA, built with Vite into static files served from Cloud Storage + CDN. "Static" describes how the app shell is delivered, not whether the page shows live data. The browser downloads the same unchanging files from the CDN, then the JavaScript makes its own live HTTP calls to `portal/backend` to fetch real, current data on a timer — the "dashboard that updates every few seconds" feeling comes entirely from that client-side polling, not from anything the server did differently per request.

The page a producer actually bookmarks is the **home dashboard** (`/`) — a list of producer data contracts with a search box matching on either `producer_id` or a human-readable name. The saga records a readable name alongside the ID the first time it writes a deployment record specifically so this search works. Selecting a result navigates client-side (no page reload, no new file fetched from the CDN) to that producer's live status view.

**`portal/backend`** is one Cloud Run service with two distinct read-only jobs:

- **`status-api/`** reads Firestore's deployment records and saga checkpoints, and exposes the list/search endpoint powering the home dashboard — matching on `producer_id` or the recorded name. This is what renders each saga step live while a deployment is in progress.
- **`metrics-client/`** queries Confluent Cloud's own Metrics API — topic-level produce rate, last-message timestamp — using a separate, read-only scoped API key. A successful deployment only proves resources exist, not that data is moving. `metrics-client` is the only place in the entire system that answers "is this actually working, right now," and it gets that answer without touching the pipeline's hot path at all.

**Polling rhythm:** while a deployment is actively running, the frontend polls every 2–3 seconds, rendering each saga step as it completes (this works because `saga.workflow` already checkpoints to Firestore at every meaningful step). Once deployment reaches a terminal state, polling slows to every 30–60 seconds for ongoing health checks. The page keeps working indefinitely as a health view — a producer returns any time by going back to the home dashboard and searching again, not by remembering a URL.

**The status view also links out to that producer's Data Product page in Knowledge Catalog** (§13) — one click from operational status straight to the governed catalog entry a consumer would find when browsing.

**Auth:** portal access goes through the org's existing SSO. Both `status-api` and `metrics-client` check the authenticated user's identity against which `producer_id`s their team owns before returning anything — including through the dashboard's search, which only ever returns results the requester is allowed to see.

**What the portal deliberately does not do:** it never triggers a Terraform apply, calls `provisioning-api`'s `/cd` route, or starts a GCP Workflows execution. It never writes to Firestore. It has no integration with GitHub, no wizard, and no PR creation. If a producer wants to change their contract, they go back to git — the portal doesn't offer a shortcut. This is what keeps the portal from ever becoming a second, competing system of record. The honest cost: a producer with no git experience has no on-ramp through this tool.

**Advantages:** Exactly one system of record — the portal genuinely cannot cause drift, since it cannot write anything; a real, continuously-checkable answer to "is my data actually flowing," not just a deployment receipt; an entry point that matches how people actually navigate back to a tool they used once weeks ago; one click from operational status straight to the governed catalog entry.

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

## FAQ

### 1. Should this Cloud Run service be Go, or something like Spring Boot?

This comes up for any of the Cloud Run services and jobs in this platform, not just one — the answer is the same reasoning applied consistently:

- **Cold start matters for anything scale-to-zero.** A Go binary starts in tens of milliseconds; a JVM-based service like Spring Boot takes seconds to start unless you invest in GraalVM native compilation, which adds real build complexity. For anything sitting on the hot path or fronting CI/CD latency, this is a concrete, immediate cost.
- **Fleet consistency.** Every Cloud Run component in this platform is Go. One language means one team, one dependency-update cadence, and an engineer can move between services without a context switch.
- **When Spring Boot would actually be the better call:** if the team's core strength were Java rather than Go, or if a given service were expected to grow a much heavier surface — complex auth integrations, ORM-heavy data access, dozens of endpoints — Spring's ecosystem maturity would start to outweigh Go's cold-start edge. Given the actual shape of these services today (thin routes that mostly delegate work to Terraform, Workflows, or Firestore), that ecosystem weight isn't buying much here. This is a right-tool-for-the-current-shape call, not a claim that Go is categorically better.

### 2. Why does the CLI use git and a PR flow instead of a direct front-end portal? (§2)

Instead of the CLI scaffolding a `.dataplatform/` folder reviewed via a PR, producers could instead log into a web portal, fill out a form (topic name, schema fields, ingestion method, storage target), and submit — with the backend provisioning directly from that submission. This is a materially different design, not just a different UI skin on the same flow, because it removes git as the source of truth entirely. It lost, for these reasons:

| What git + CLI gives you for free | What a form-and-submit portal would have to build from scratch |
|---|---|
| Full version history — who changed what, when, and why (commit message) | A bespoke audit-log and versioning system, since a database row has no history unless you build one |
| Code review via pull requests — CODEOWNERS routing, required approvals, inline comments on the exact lines that changed | An equivalent approval workflow reimplemented in application code — who can approve, how reviewers see the diff, how "submit" is blocked pending approval |
| Diffable, greppable schemas — `git blame`, `git log -p`, org-wide code search across every producer's contract | Custom UI to approximate "what changed since last time," and no way to search across contracts with existing tooling |
| Rollback via `git revert` — the entire compensation-and-revert mechanism (§6) depends on git being the source of truth | A hand-built "previous version" concept and revert mechanism — essentially reinventing git's version model inside application state |
| CI/CD as the natural "propose, review, then apply" pattern — this is just how git-triggered pipelines already work | Custom logic to recreate the same safety separation, since a form submission has no natural "pull request" analog |
| Producers edit `.proto` files in their own IDE, with language-server support, and can test schema changes locally before touching the platform | A web form for authoring arbitrary protobuf — painful UX for anything beyond flat messages, or a dumbed-down subset of what producers can actually express |

**The honest gap this leaves:** non-technical users genuinely find a form friendlier than learning git and PRs — and this platform doesn't currently solve that. The portal (§12) is purely observational, with no write path at all; a producer with no git/PR experience has no on-ramp today. That's a deliberate scoping decision, not an oversight — a future non-technical on-ramp, if built, deserves its own dedicated design rather than being bolted onto a monitoring dashboard.

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
| Cloud SQL / Postgres | Relational would model deployment records fine, but lacks a native push/listener mechanism, for data whose shape (varying config per producer, per egress type) fits documents more naturally than a fixed schema anyway. |

### 10. Why build on Knowledge Catalog instead of a custom catalog, or treating Firestore as the catalog? (§13)

| Option | Why it lost |
|---|---|
| Build a custom catalog and access-request workflow from scratch | Would mean re-implementing search, lineage graphing, approval routing, and a governance UI — all of which Knowledge Catalog already provides natively. |
| Treat Firestore as the catalog | Firestore has no search, no lineage graph, no org-wide discovery UI, and no consumer-facing browse/request experience. It's the right tool for real-time operational state, the wrong tool for organization-wide discovery. |

### 11. Why prefer a managed connector over Dataflow for consumer fan-out, wherever one exists? (§14)

Less custom code to operate, and Confluent already handles connector-level scaling and retry. Dataflow remains necessary both for the combinations no connector covers, and structurally — a producer's own sink (§10) is fixed and always-on, while a consumer-requested relay needs an arbitrary source relaying into a destination created and destroyed per individual grant, a shape existing connectors aren't built for regardless of which storage type is involved.

---

## Design principles this all traces back to

| Principle | Where it shows up |
|---|---|
| One system of record | Git is the only place provisioning is *declared*; the portal never writes; Terraform state is the only place "what exists" is recorded |
| Control plane vs. hot path, strictly separated | Workflows/Terraform never appear on the publish path; Firestore is the only bridge |
| Revert is symmetric with create | Compensation is "apply the previous commit's generated vars," not bespoke undo code per resource |
| Least privilege by construction | Confluent Kafka credentials live only in the Dataflow service account; per-producer Terraform state prevents cross-producer blast radius |
| Fail fast, cheaply | `/ci` and validation reject bad input before any real execution starts |
| Safety nets have their own safety nets | Saga compensation catches in-flight failures; `terraform plan`-based reconciliation catches everything the saga couldn't see happen |
| One generic mechanism, not one per producer | The pipeline's single Beam template serves every producer through runtime parameters, never a compiled-in, producer-specific path |
| Not everything needs to go through git | Schema and infrastructure changes do, deliberately. Access grants deliberately don't — the right check for "should this consumer see this data" is a business decision made fast by an owner, not an engineering review of a diff |
| Be honest about a dependency's own limits | Firestore is genuinely real-time; Knowledge Catalog is not, and that's stated plainly rather than implied to be seamless |

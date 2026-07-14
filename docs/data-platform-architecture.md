# Data Platform Architecture

A GitOps-based, self-service data platform where producer teams declare data contracts in git, Terraform is the sole creator of all producer infrastructure, and a separate always-on hot path handles real-time publishing without ever depending on the control plane at request time.

Every section below follows the same structure: what the component is, how it works, what alternatives were considered and why they lost, and the concrete advantages of the choice made.

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
├── ingestion-gateway/                   Cloud Run service (gRPC-stream + REST)
│   ├── proto/gateway.proto               client-streaming Publish RPC
│   ├── transport/grpc/, transport/rest/  two adapters, one internal pipeline
│   ├── validate/                        dynamic protobuf validation
│   ├── wireformat/                      Confluent envelope construction
│   ├── cache/                           Firestore bulk hydrate + realtime listener
│   └── produce/                         Kafka producer
│
├── ingestion-gateway-sdk/               platform-provided clients: go/, python/, java/, node/
│
├── pull-ingestion-pipeline/             Apache Beam (Java), Dataflow Flex Template
│   ├── src/                             pull from source, serialize, call gateway
│   └── template/                        Flex Template Dockerfile + spec
│
├── egress-api/                          Cloud Run service (REST), Go
│   ├── routes/
│   │   ├── discovery.go                 GET /v1/:producer_id
│   │   ├── query.go                     GET /v1/:producer_id/:table
│   │   └── openapi.go                   GET /v1/:producer_id/openapi.json
│   ├── adapters/
│   │   ├── bigquery.go
│   │   └── bigtable.go
│   └── cache/                           Firestore grants + schema, same pattern
│                                        as ingestion-gateway's cache
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
├── access-portal/                       separate from portal/ — consumer-facing, not producer-facing
│   └── frontend/                        React + TypeScript, static bundle, no backend needed
│                                        — calls egress-api's discovery + openapi routes directly
│
├── infra/                               Terraform, platform's own resources
│   ├── firestore.tf
│   ├── secret-manager.tf                includes read-only Confluent metrics key
│   ├── iam.tf                           WIF pool/provider, per-service roles
│   ├── cloud-run.tf
│   ├── scheduler.tf
│   ├── kafka-cluster.tf                 Confluent Cloud references
│   └── modules/
│       ├── producer-contract/           Confluent + Google providers, conditional Dataflow,
│       │                                sink connectors, conditional pull-ingestion Dataflow
│       └── consumption-patterns/        applied on access-grant approval, not on merge
│           ├── direct-access/           just an IAM grant, no new resource
│           ├── kafka-mirror/            new topic + egress-fanout-pipeline job
│           ├── pubsub-subscription/     new subscription + egress-fanout-pipeline job
│           └── rest-api/                writes route config, no new resource
│
└── .github/workflows/
    ├── cli-release.yml
    ├── provisioning-api-deploy.yml
    ├── orchestrator-deploy.yml
    ├── terraform-job-deploy.yml
    ├── ingestion-gateway-deploy.yml
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

| Component | Language / framework | Why, over the strongest alternative |
| --- | --- | --- |
| `cli/` | Go + Cobra | Single static binary, no runtime dependency on arbitrary laptops. See §3 for the full Python/Node/Rust comparison. |
| `provisioning-api/` | Go, plain `net/http` | Cold-start matters — this is scale-to-zero. A Go binary starts in tens of milliseconds; Spring Boot's JVM takes seconds unless you invest in GraalVM native compilation, which adds real build complexity. Also keeps one language across the CLI, this service, and the gateway. |
| `ingestion-gateway/` | Go, gRPC-stream + REST | Same cold-start reasoning as `provisioning-api`, sharper here — `min-instances` exists specifically to fight cold starts on the hot path. Dual transport since a single-protocol default didn't fit every producer's actual constraints — see the dedicated ingestion gateway document. |
| `ingestion-gateway-sdk/` | Go, Python, Java, Node — one platform-maintained client per language | Exists specifically so producers never touch generated gRPC stubs directly; this is what actually resolves the "had to build a client" and "no self-service debugging" feedback, not a transport change alone. |
| `terraform-job/` | Bash entrypoint + Terraform (HCL) | The job is "checkout, compile, run terraform" — a shell script calling three CLIs. No application logic here that would justify a general-purpose language. |
| `pull-ingestion-pipeline/` | **Java**, Apache Beam | The one deliberate break from "everything is Go." The Beam Go SDK is real but meaningfully less mature than Java's — fewer built-in source connectors, weaker windowing/state support, and Dataflow's deepest, most battle-tested support has historically been for Java pipelines. This is a capability gap, not a preference. |
| `egress-fanout-pipeline/` | **Java**, Apache Beam | Same reasoning as `pull-ingestion-pipeline` — genuinely the same technology, running in the opposite direction (out of egress storage, into a consumer-specific topic or subscription, instead of into the platform). |
| `egress-api/` | Go | Same cold-start and fleet-consistency reasoning as `provisioning-api` and `ingestion-gateway`. |
| `shared/validation-lib`, `shared/policy-bundles`, `shared/contract-compiler` | Go (lib/policy), Rego (policy rules) | Go so they compile directly into the CLI and `provisioning-api` as imports, not subprocess calls — see §2. |
| `portal/frontend/` | React + TypeScript, built with Vite | A client-side SPA calling a REST API is the simplest thing that works for an internal, authenticated tool — no SEO requirement that would justify a server-rendering framework like Next.js. |
| `access-portal/frontend/` | React + TypeScript, built with Vite | Same reasoning as `portal/frontend`, but a genuinely separate deployable — different audience (consumers, not producers), and needs no backend of its own since `egress-api` already serves everything it renders. |
| `portal/backend/` | Go | Same reasoning as `provisioning-api` — thin service, mostly delegating to Firestore reads and the Confluent Metrics API. |
| `orchestrator/` | GCP Workflows YAML | Not a general-purpose language by design — see §8 for why a durable, managed state machine beats hand-rolled orchestration. |
| `infra/` | Terraform (HCL) | See §1 for the Pulumi/Deployment Manager comparison. |

**The honest caveat on Go vs. Spring Boot for `provisioning-api`:** if the team's core strength were Java rather than Go, or if this service were expected to grow a much heavier surface — complex auth integrations, ORM-heavy data access, dozens of endpoints — Spring's ecosystem maturity would start to outweigh Go's cold-start edge. Given the service's actual shape today (four thin routes that mostly delegate work to Terraform and Workflows), that ecosystem weight isn't buying much, while the cold-start and fleet-consistency advantages are concrete and immediate. This is a right-tool-for-the-current-job call, not a claim that Go is categorically better.

---
## 1. Terraform as infrastructure (`infra/` — platform infra, distinct from producer-contract Terraform)

**Two separate Terraform layers, deliberately not merged:**
- `infra/` — the platform's own resources (Firestore, IAM/WIF, Secret Manager, every Cloud Run service, Cloud Scheduler). Runs rarely, platform-team-driven.
- The shared producer-contract module (§6) — runs frequently, once per producer PR, with state isolated per producer.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Pulumi | Comparable capability, but Terraform's Confluent and Google providers are more mature and widely used for exactly this combination, with more community precedent to draw from. |
| Google Cloud Deployment Manager | GCP-only, effectively legacy relative to Terraform, and wouldn't have covered the Confluent side at all. |
| One combined state for platform infra and all producer resources | Rejected for the same blast-radius reason as a shared producer state — a platform-infra change and a producer's PR merge should never be able to lock or affect each other. |

**Advantages:** `terraform show`/`plan` gives an inspectable, authoritative record of what actually exists, for both layers, without any custom state-tracking code.

---

## 2. Shared libraries (`shared/`)

### `validation-lib`
Proto lint, schema compatibility checks (calls Confluent Schema Registry's compatibility endpoint), and config-schema validation. Imported by the CLI (locally), by `provisioning-api` (server-side), and invoked as a standalone binary inside the Cloud Run Job that runs Terraform.

### `policy-bundles`
OPA/Rego rules — e.g., pull-ingestion credentials must reference Secret Manager, never a literal value; push-ingestion service accounts may only request `roles/run.invoker` on the shared gateway. Checked wherever `validation-lib` runs.

### `contract-compiler` *(new)*
A CLI that reads `.dataplatform/{schema,ingestion,egress}` at a given commit and emits `terraform.tfvars.json`, matching the shared Terraform module's variable schema. This is the piece that turns a producer's declared intent into Terraform's language.

**Alternatives considered (for all three):**

| Option | Why it lost |
| --- | --- |
| Logic embedded only in `provisioning-api`, no shared package | CLI would either duplicate the logic (drift risk) or require network access just to lint a file before committing — bad local UX. |
| Logic embedded only in the CLI, server trusts the client | Server-side enforcement becomes optional — anyone bypassing the CLI (a raw `git commit`, a different tool) skips validation entirely. |
| Hand-written Terraform files per producer, no compiler | Works at small scale, but means every new producer needs someone to hand-author correct Terraform — the entire point of a self-service contract disappears. |

**Advantages:** One codebase for each concern, consumed identically everywhere it's needed; policy and compiler logic version and release independently of any single service's deploy cadence.

### Which components use which library

| Library | Used by | How |
| --- | --- | --- |
| `validation-lib` | `cli/` (`datapltfm validate`) | Imported as a Go package — proto lint, schema compat, config schema checks, run locally before commit |
| `validation-lib` | `provisioning-api/routes/{ci,cd}.go` | Imported as a Go package — the same checks, run server-side before a Job is ever triggered |
| `validation-lib` | `terraform-job/entrypoint.sh` | Invoked as a standalone compiled binary — a defense-in-depth re-check immediately before `terraform plan`/`apply`, in case something reached this point without going through `/ci` or `/cd` |
| `policy-bundles` | Same three components as `validation-lib` | Checked at the same points, alongside it |
| `contract-compiler` | `terraform-job/entrypoint.sh` only | Invoked as a standalone binary — turns the checked-out `.dataplatform/` into `terraform.tfvars.json`. Not used by the CLI or `provisioning-api` directly; generating Terraform variables is specifically a CI/CD-time operation |

**Not shared, deliberately:** `ingestion-gateway/validate/` (dynamic protobuf validation of individual *messages* at publish time) is gateway-specific code, not part of `shared/`. It solves a different problem than `validation-lib` — `validation-lib` checks whether a `.proto` *file* is well-formed and compatible at commit time; the gateway's validator checks whether one *message* conforms to an already-registered schema at publish time. Conflating these would mean loading CI/CD-oriented tooling into the hot path for no reason. `pull-ingestion-pipeline/` needs the same technique as the gateway's validator but, being Java rather than Go, implements it separately — the same approach, duplicated across the language boundary rather than shared as code.

---

## 3. CLI (`cli/`)

**What it is:** `datapltfm init` / `datapltfm update` / `datapltfm validate` — scaffolds, refreshes, and locally validates, all in `.dataplatform/`'s repo without writing any integration code (full reasoning in `data-platform-ingestion-gateway-guide.md`).

**Language and framework:** **Go**, using **Cobra** (the framework behind `kubectl`, `docker`, `gh`, and `helm`) for subcommands, flags, and shell completion.

**How it works:** `init` fetches the latest proto templates, config schemas, and CI/CD workflow templates from the platform's central registry and writes them into a new repo. `update` re-fetches later so a repo never drifts far from what the platform currently enforces. `validate` (`cli/cmd/validate.go`) runs `shared/validation-lib` and `shared/policy-bundles` against the working directory on demand — not just at scaffold time, so a producer can re-check their contract after every edit, before ever committing. It statically links `validation-lib` as an imported Go package, so local lint behavior is byte-for-byte identical to what CI runs server-side — not a reimplementation, the same compiled code.

**Advantages of Go + Cobra specifically here:**
- Compiles to a single static binary per OS/architecture — no runtime dependency, no version-matching issues on a developer's machine.
- Same language as `provisioning-api` and `ingestion-gateway` — one team, one set of idioms, one dependency-update cadence to track.
- `shared/validation-lib` compiles into the CLI as a direct import, not a subprocess call — zero risk of the CLI's validation logic silently diverging from the server's.
- Distributed via GitHub Releases (cross-compiled per OS/arch) or `go install` for Go-native users — no package registry to operate.

### Alternative interface considered: a direct front-end portal, bypassing git entirely

Instead of the CLI scaffolding a `.dataplatform/` folder reviewed via a PR, producers could instead log into a web portal, fill out a form (topic name, schema fields, ingestion method, storage target), and submit — with the backend provisioning directly from that submission. This is a materially different design, not just a different UI skin on the same flow, because it removes git as the source of truth entirely. It lost, for these reasons:

| What git + CLI gives you for free | What a form-and-submit portal would have to build from scratch |
| --- | --- |
| Full version history — who changed what, when, and why (commit message) | A bespoke audit-log and versioning system, since a database row has no history unless you build one |
| Code review via pull requests — CODEOWNERS routing, required approvals, inline comments on the exact lines that changed | An equivalent approval workflow reimplemented in application code — who can approve, how reviewers see the diff, how "submit" is blocked pending approval |
| Diffable, greppable schemas — `git blame`, `git log -p`, org-wide code search across every producer's contract | Custom UI to approximate "what changed since last time," and no way to search across contracts with existing tooling |
| Rollback via `git revert` — the entire compensation-and-revert mechanism (§8) depends on git being the source of truth | A hand-built "previous version" concept and revert mechanism — essentially reinventing git's version model inside application state |
| CI/CD as the natural "propose, review, then apply" pattern — this is just how git-triggered pipelines already work | Custom logic to recreate the same safety separation, since a form submission has no natural "pull request" analog |
| Producers edit `.proto` files in their own IDE, with language-server support, and can test schema changes locally before touching the platform | A web form for authoring arbitrary protobuf — painful UX for anything beyond flat messages, or a dumbed-down subset of what producers can actually express |

**The honest gap this leaves:** non-technical users genuinely find a form friendlier than learning git and PRs — and this platform doesn't currently solve that. The portal (§14) is purely observational, with no write path at all; a producer with no git/PR experience still has no on-ramp today. That's a deliberate scoping decision, not an oversight to paper over — worth flagging explicitly rather than implying the portal covers it, since a future non-technical on-ramp, if built, deserves its own dedicated design rather than being bolted onto a monitoring dashboard.

---

## 4. GitHub Actions (`.github/workflows/`)

**Platform deploy workflows** (path-filtered, one per component) versus **reusable workflows** (`producer-ci.yml`, `producer-cd.yml`) referenced by every producer repo.

**Alternatives considered:** Each producer repo maintains its own copy of the CI/CD pipeline logic — rejected outright; that's exactly the drift risk the reusable-workflow pattern exists to prevent, since all real logic lives server-side in `provisioning-api` regardless.

**Advantages:** A platform-team change to CI/CD behavior ships by editing one file; producer repos' own workflow files stay nearly static and need almost no maintenance.

---

## 5. Provisioning API (`provisioning-api/` — Cloud Run service, Go)

**What it is:** One Cloud Run service, four routes: `/ci`, `/cd`, `/jobs`, `/reconcile`.

**How it works:** `/ci` runs validation + policy checks, then triggers a **plan-only** run of the same Cloud Run Job used for apply (see §6), so CI and CD are provably running identical logic. `/cd` starts a GCP Workflows saga execution. `/jobs` is polled for status. `/reconcile` is called by Cloud Scheduler and diffs live state against declared state, invoking compensation on drift.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| GitHub Actions calls GCP Workflows/Cloud Scheduler directly, no API layer | Seriously considered — see the dedicated comparison below. Rejected for permission-brokering and fail-fast reasons. |
| Cloud Functions instead of Cloud Run | Functions are simpler for pure request/response, but Cloud Run's finer control over concurrency, container startup, and consistent tooling with the rest of the platform's services won out — no reason to introduce a second compute model for one service. |
| gRPC instead of REST | The caller is a `curl` step in CI YAML — gRPC client tooling in a shell step is pure friction for no benefit at this traffic volume. |

**Why keep the API over calling GCP directly (the alternative seriously evaluated):**
- **Permission brokering.** The API's own service identity holds the real internal invoke permissions (`roles/workflows.invoker`, etc.). External callers (any producer repo, via a single shared, org-wide WIF identity) only ever need permission to call *the API* — not every internal resource the platform might grow to include. Without this layer, every new internal workflow or job means widening what the shared external identity can reach.
- **Fail fast, cheaply.** A malformed request or invalid config is rejected in milliseconds, before a Workflows execution or a Job run ever starts — keeping the execution history meaningful and avoiding wasted compute on requests that were never going to succeed.
- **Insulation from internal change.** Renaming a workflow, splitting the saga, or swapping the execution engine is a server-side deploy, not a rollout that has to reach every producer repo (even with `datapltfm update` propagating template changes, adoption isn't instant).
- **Response shaping.** The API can return "here's what will change to your Kafka topic and schema," not Workflows' generic execution-status JSON — directly usable in a PR comment or the portal.
- **A home for policy that doesn't belong in Terraform or Workflows** — concurrency limits, freeze windows, rejecting unregistered producer IDs.

**Advantages:** All of the above, at the cost of one more service to deploy and operate — judged worth it given the platform is expected to grow more internal complexity over time, not less.

---

## 6. Terraform execution — Cloud Run Jobs (`terraform-job/` — new component, replaces direct API calls)

**What it is:** One container image, built from `terraform-job/Dockerfile` + `terraform-job/entrypoint.sh`, containing `git`, `terraform`, and the `contract-compiler` binary — deployed as **two** distinct Cloud Run Job resources, since a Job's service account is fixed per-resource and plan needs read-only while apply needs write:

- **`terraform-plan-job`** — read-only service account. Used by `/ci`.
- **`terraform-apply-job`** — write-scoped service account. Used by `/cd`'s forward apply, and reused for revert with an execution-time override pointing at the previous commit's SHA instead of the merge SHA — not a third Job resource.

**How it works:** `entrypoint.sh` checks out the producer repo at a given SHA → runs `contract-compiler` to generate `terraform.tfvars.json` → runs `terraform plan` (`terraform-plan-job`) or `terraform apply` (`terraform-apply-job`) against **that producer's isolated Terraform state** (a GCS backend with a per-producer key prefix). Both Jobs reference the same shared Terraform module, `infra/modules/producer-contract/`, which wraps the Confluent provider (topic, schema resources) and the Google provider (BigQuery/Bigtable/AlloyDB/Firestore/GCS depending on the producer's chosen egress target, plus IAM bindings).

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Cloud Build | Purpose-built for exactly this (native GitHub-trigger integration, built-in Terraform step support) and a completely reasonable choice. Lost narrowly to Cloud Run Job for architectural consistency — every other compute piece in this platform is already Cloud Run, and introducing a second distinct product for one component adds a second mental model and console to operate for a use case ("run a container to completion") that Cloud Run already covers. |
| **Run terraform inline inside `provisioning-api`'s own handler, no separate Job at all** | See below — this is worth walking through in detail, since it's the most tempting shortcut and the reasons against it are structural, not stylistic. |
| One shared Terraform state for all producers | Rejected outright — a shared state file means one producer's apply can lock or, worse, accidentally touch another producer's resources. Blast-radius isolation, not just performance, is why state is split per producer. |
| GCP Workflows calling provider APIs directly (the pre-pivot design) | Required hand-writing REST calls per resource type, and manual LIFO compensation. Terraform's own state and diffing engine does both create and revert for free once it owns the resources. |

**Why terraform doesn't just run inside `provisioning-api` itself — five separate reasons, not one:**

1. **Request duration doesn't fit.** Cloud Run *Services* cap request duration (up to 60 minutes, still a hard ceiling) — built for request/response traffic, not long-running work. A heavier apply (Bigtable, say) can genuinely run long. Cloud Run *Jobs* are a different product built specifically for run-to-completion workloads, with task timeouts up to 24 hours.
2. **Service instances get killed mid-request, routinely — Jobs are guaranteed to finish.** Cloud Run Service instances are recycled constantly (scale-down, every deploy, occasional host maintenance) with no awareness of whether a request is mid-flight. Fine for a stateless handler that can just retry; dangerous for `terraform apply` — an instance killed halfway through leaves infrastructure partially applied with no clean signal about what happened. A Job execution is explicitly guaranteed to run to completion or report a real failure.
3. **IAM separation becomes structurally impossible.** A Cloud Run *Service* has exactly one service account for the whole service, shared across every request. If terraform ran inline in `provisioning-api`, that one identity would need write-scoped apply permissions to handle `/cd` — and since `/ci` runs in the *same* service, that write-scoped identity becomes reachable, at least in principle, from the plan-only path too. The "CI genuinely cannot mutate anything, enforced by IAM, not convention" property from §5 only holds because plan and apply run as two distinct Job resources with two distinct service accounts. One Service handling both can't provide that.
4. **Blast radius.** Terraform provider plugins (Confluent's, Google's) are third-party code. If one hangs or crashes during a complex apply, that shouldn't be able to take down the same process simultaneously handling every other producer's `/ci` requests and `/jobs` polling. A separate Job isolates a bad run to its own container.
5. **Different resource profiles.** `provisioning-api`'s handlers are cheap — auth, kick off an execution, read a status. Terraform is heavier — provider binaries, in-memory state, large diffs. Sizing one service for both means over-provisioning the common case or under-provisioning the rare heavy case; a dedicated Job resource is sized for exactly what it needs, independently.

**A caveat carried over, not solved away:** a naive revert-apply would try to delete a Confluent schema version if the previous config no longer declares it — the same "should you ever delete a schema version" risk flagged earlier. The shared module sets `lifecycle { prevent_destroy = true }` on the schema resource specifically, so Terraform refuses that particular destroy rather than silently doing it.

**Advantages:** Revert is symmetric with forward apply — no bespoke undo code per resource type; `terraform plan` becomes a genuine drift detector for §12; adding a new egress storage type is a module change, not new orchestration code.

---

## 7. Confluent Cloud (Kafka + Schema Registry — external, managed)

**What it is:** The internal streaming backbone every producer's data lands in via `ingestion-gateway`, regardless of what egress target that producer eventually chose. This is a narrower decision than it might look — Pub/Sub was never excluded from the platform; it's already available as one of the egress storage targets a producer can pick for their own consumption pattern (alongside BigQuery, Bigtable, AlloyDB, Firestore, Cloud Storage). What's being decided here is only what the platform itself runs underneath every producer before that choice ever comes into play.

**How it works:** Both created and read through the Confluent Terraform provider now, not hand-written REST calls. Schema compatibility (`BACKWARD`, etc.) is enforced by CSR itself — the same check `/ci`'s plan-only Job run surfaces to a PR reviewer is the exact check that gates the real apply.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Self-hosted Kafka + Schema Registry | Rejected for operational cost — running and patching a cluster is a full-time concern this platform doesn't need to take on, versus paying for a managed control plane. |
| **Google Cloud Pub/Sub, as the internal backbone** | See below — a genuinely close call, not a lopsided one. |

**The core structural difference driving all of this:** Pub/Sub has no equivalent to a Kafka partition. A Pub/Sub topic fans out to explicitly-created **subscriptions**, each an independent copy with its own acknowledgment tracking. Kafka instead retains one ordered, append-only log per partition, independent of who's reading it — any consumer group, including one created long after messages were published, reads that same log using its own independently tracked offset.

**Kafka over Pub/Sub, specifically for this role:**

- **Replay and retention work differently at the mechanical level.** A Pub/Sub subscription only receives messages published *after it was created* — a subscription that didn't exist yet never sees history published before it. Google added **topic-level retention** that lets a newly-created subscription `seek()` back into a retained window, which narrows this gap — but it's an opt-in feature layered on top of the subscription model, not the default behavior. In Kafka, the partition's retention window is simply a property of the topic itself; there's no "did a subscription exist yet" question for any consumer group, new or old. That matters directly here, since the platform is explicitly designed to fan one producer's stream out to consumers who may onboard well after the data was originally produced.
- **Ordering is structural in Kafka, opt-in in Pub/Sub.** Pub/Sub delivers messages unordered by default. Enabling ordering means attaching an `ordering_key` to published messages and turning ordering on for the subscription — and the publisher client library then enforces **one outstanding publish request per ordering key at a time**, capping throughput for that key to preserve order. Kafka's ordering isn't a setting at all: it falls directly out of a partition being an append-only log, so any consumer reading that partition sees records in exactly the order the broker appended them, with no configuration involved.
- **Ecosystem depth, not just feature presence.** Pub/Sub Schemas (Avro/Protobuf) are real and genuinely convenient — validated server-side at publish time, no client-side wrapping needed. But the feature is newer (~2021) and comparatively thin: no equivalent to CSR's `BACKWARD`/`FORWARD`/`FULL` compatibility modes enforced transitively across every prior version, no Kafka Connect-sized connector catalog, no ksqlDB-style stream processing built around it. It validates a message against a schema; it doesn't carry the surrounding tooling this design already leans on throughout its schema versioning, compatibility-checking, and wire-format work.
- **Cloud portability.** Kafka is an open, vendor-agnostic standard; Pub/Sub is GCP-proprietary. For something positioned as a foundational, org-wide platform rather than one team's internal tool, that's a real hedge against deeper GCP lock-in — even while every other component here happily runs on GCP compute.

**Where Pub/Sub would genuinely have been the simpler choice — worth being honest about:**

- **Native GCP IAM, mechanically simpler.** Pub/Sub access is granted with an ordinary `google_pubsub_topic_iam_member` Terraform resource — the exact same IAM pattern used for every other GCP resource in this system, authenticated automatically via Workload Identity, no separate credential to manage. Confluent Cloud has **its own entirely separate identity plane** — API keys scoped per-cluster with their own ACL system, not GCP IAM at all, even though everything accessing it runs on GCP. That's the direct, mechanical reason this design needed Secret Manager entries for Confluent credentials and the read/write key-separation scheme between the saga and `/reconcile` (§12) — none of that machinery would exist if the backbone were Pub/Sub.
- **Zero cluster or capacity concept.** Fully serverless with no tier or sizing decision, and likely cheaper at low or bursty volume, since there's no cluster baseline cost the way even a managed Kafka tier has.
- **Tighter native GCP integration in places.** Direct Pub/Sub-to-BigQuery subscriptions, for instance, can skip a separate Dataflow job for some patterns that this design currently routes through more custom machinery.

**Advantages:** Spec-compliant wire format means any downstream consumer can use off-the-shelf Confluent deserializers with zero custom code; the log/replay model matches the platform's actual job (fan-out to many independent, possibly-later-arriving consumers) more closely than a queue does.

### How a producer's declared egress actually gets populated

`egress.yaml`'s `storage_target` (BigQuery, Bigtable, etc. — see §3) needs something to continuously move data from the internal topic into that storage. This is **not** a custom pipeline — Confluent Cloud already ships 100+ fully-managed Kafka Connect sink connectors, confirmed available for BigQuery (the V2 connector, using BigQuery's Storage Write API) and BigTable specifically, with Cloud Storage and Pub/Sub sinks very likely covered too. `infra/modules/producer-contract/` provisions the appropriate `confluent_connector` resource — one more resource in the *same* module that already creates the topic and schema, via the same `terraform-apply-job`. No new component, no custom code, for the common case.

Where no managed connector exists for a given target (possibly AlloyDB or Firestore, worth confirming at build time), the module falls back to the Dataflow relay pattern described in §17 — but that's the exception, not the default.

---

## 8. Orchestrator — GCP Workflows (`orchestrator/` — 3 independent definitions)

**What it is:** `saga.workflow.yaml`, `compensation.workflow.yaml`, `revert/git-revert.workflow.yaml`.

**How it works:** `saga.workflow` no longer calls Confluent or GCP APIs directly — its entire job is to trigger the Terraform-executing Cloud Run Job (§6), poll it, and branch. On success, it reads the Job's Terraform outputs (e.g., the assigned schema ID) and writes them to Firestore. On failure, it calls `compensation.workflow`, which triggers a **second** Job run — this one checking out the *previous* commit, regenerating vars from that older contract state, and applying — letting Terraform's own diff compute the revert. Only if that succeeds does `git-revert.workflow` push a revert commit to main.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Cloud Composer / Airflow | Built for data-pipeline DAGs at a much heavier operational cost — a managed cluster, not serverless — for a workload that's a handful of executions a day. |
| Cloud Tasks | A simple queue, no native branching, retry-with-backoff, or try/except error handling — you'd rebuild Workflows' error-handling model by hand. |
| Hand-rolled state machine inside `provisioning-api` | Execution state would live inside a Cloud Run instance's memory — and Cloud Run instances are recycled constantly (scale-down, deploys, host maintenance), so a mid-saga instance death would lose track of where the saga was. Workflows persists execution state independent of any compute instance's lifetime. |
| Custom LIFO compensation stack (the original design, before the Terraform pivot) | Required hand-writing "how to undo" for every resource type. Superseded entirely — revert is now just "apply the previous desired state" and Terraform computes the diff. |

**Advantages:** Durable, resumable execution with native retry/branching, built by Google rather than hand-maintained; compensation logic collapsed from custom per-resource-type code to one generic "re-apply an earlier commit's vars" operation.

### Why Workflows, specifically: the stateful memory a Cloud Run Job doesn't have

It's worth being precise about *which* state is being discussed here, because this system actually has three distinct kinds, each owned by a different component:

1. **Infrastructure state** — what GCP/Confluent resources actually exist. Owned by the Terraform state file (§6, §1).
2. **Orchestration state** — where a given saga run currently is: which step it's on, what the previous Job's outcome was, whether to proceed or compensate. This is what's being discussed here.
3. **Hot-path mirror data** — schema IDs and deployment status for the gateway and portal to read. Owned by Firestore (§10).

A Cloud Run Job is excellent at the first axis's execution — "run this bounded unit of work (a `terraform apply`) reliably to completion" — but it has **no facility at all for the second axis**. A Job execution is a container that starts, runs, exits, and is gone. It doesn't know it's one step in a larger sequence, doesn't know what to do next, and retains nothing about itself once it exits except whatever it explicitly wrote elsewhere. There's no concept inside the Job primitive of "if I fail, invoke that other Job" — any such branching has to be coordinated by something outside it.

That's the specific gap GCP Workflows fills. Its execution — the variables, the current step, which branch it took — persists as a durable, managed resource **inside the Workflows service itself**, independent of any container or compute instance:

- When `saga.workflow` starts a Job execution and waits, the correlation between "I started Job run X" and "here's what happens when X finishes" stays intact for as long as that Job takes, even if it runs for many minutes.
- Its `try`/`except` blocks retain everything accumulated earlier in the same execution — so when a Job fails, the workflow still knows exactly what state the saga was in when it happened, without needing to have written that context to an external store first.
- This durability is Google-managed: the execution survives underlying infrastructure hiccups without your code needing to implement any checkpoint/resume logic by hand.

**What the alternative would look like without Workflows** — and why it was rejected: coordination would have to live somewhere else. Two candidates, both worse:

- **A Job triggers the next Job directly at the end of its own script.** Now orchestration logic (what happens on failure, when to compensate) is scattered across multiple Job containers whose actual job should just be "run terraform" — and there's no central execution history to look at when something goes wrong.
- **`provisioning-api` coordinates it**, polling Job status and holding "which step we're on" in its own request-handler state. This reintroduces the exact problem discussed in §5 and elsewhere: Cloud Run *service* instances are recycled constantly — scale-down, deploys, host maintenance — so any orchestration state held in an instance's memory is lost the moment that instance is killed mid-saga. Avoiding that would mean hand-building your own checkpoint-to-Firestore-after-every-step system with your own resume logic — which is, in effect, reimplementing what GCP Workflows already provides, without Google's durability guarantees or its visual execution-history UI to debug a stuck saga.

---

## 9. Pull ingestion — Dataflow (`pull-ingestion-pipeline/` — new component)

**What it is:** When `.dataplatform/ingestion/` declares `method: pull` instead of `push`, the platform itself becomes the caller — a continuously-running Apache Beam pipeline, launched as a Google Cloud Dataflow job, pulls from the producer's source on their behalf.

**How it works:** One generic, parameterized Beam pipeline — not a bespoke pipeline per producer — deployed as a single Dataflow Flex Template and launched with different runtime parameters (source config, schema version, target route) per producer. This mirrors the same reasoning behind the gateway's single generic `Publish` RPC instead of a typed method per producer.

1. The pipeline pulls from the declared source (API endpoint, Pub/Sub topic, etc. — whatever `.dataplatform/ingestion/` specifies).
2. It serializes each record into the producer's schema using **dynamic protobuf construction against a descriptor fetched from Firestore** — the identical technique the gateway already uses, so there's still no producer-specific compiled type anywhere in the platform's own code.
3. It calls the **existing, unmodified** `ingestion-gateway.Publish` RPC with the serialized bytes. The gateway has no idea whether the caller is a producer's own app or a platform-provisioned pipeline — zero changes needed there.

**Provisioning is not a new mechanism.** It's a conditional resource inside the same shared Terraform module, `infra/modules/producer-contract/`, created only when pull is declared. `contract-compiler` gains the job of emitting Dataflow launch parameters into the same `terraform.tfvars.json` it already generates for every other resource type — one more branch in an existing compiler, not a parallel system.

The Dataflow job's own service account — never the producer's — gets `roles/run.invoker` on the gateway, plus read access to the source via a Secret Manager reference (same "never a literal credential" policy rule as push). It's created and destroyed by the same `terraform-apply-job` as everything else.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Beam Go SDK, to keep the whole platform in one language | Meaningfully less mature than Java's SDK for Dataflow specifically — fewer built-in source connectors, weaker windowing/state support. This is a real capability gap, not a preference for consistency's sake. |
| A bespoke pipeline per producer | Same failure mode as a bespoke Terraform config per producer — every new pull-ingestion producer would need someone to hand-write a new pipeline, defeating self-service. |
| Cloud Composer/Airflow scheduling periodic pulls, instead of a continuously-running Dataflow job | Batch-oriented and adds a managed-cluster operational cost for a job that's naturally a continuous streaming pull, not a scheduled batch. |
| Producer's source data pushed by Dataflow directly to Kafka, bypassing the gateway | Would mean the pipeline needs direct Kafka IAM and reimplements schema validation — exactly the two things the gateway exists to centralize. |

**A carve-out worth being deliberate about:** teardown uses Dataflow's `on_delete = "drain"` rather than cancel, so in-flight pulled data finishes processing rather than being dropped mid-record — the same kind of deliberate exception as the schema resource's `prevent_destroy`.

**Advantages:** Zero changes to the gateway or the hot path it's already been hardened around; one pipeline template serves every pull-ingestion producer; provisioning and teardown reuse the exact same Terraform machinery as every other resource type, rather than a second bespoke system.

---

## 10. Firestore — the only shared node

**How it works:** Holds deployment/saga-log records and a mirror of CSR (`subject → schema_id → descriptor`), written by the saga once Terraform apply succeeds, read continuously by the ingestion gateway's in-memory cache via a realtime listener.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Bigtable | Built for a different scale/shape of problem (millions of QPS, wide-column) than low-volume platform metadata; its Change Streams don't offer the same simple SDK-level realtime listener that the gateway's cache design depends on. |
| Cloud SQL / Postgres | Relational would model deployment records fine, but lacks a native push/listener mechanism — you'd be building custom polling or a CDC pipeline to get what Firestore gives natively, for data whose shape (varying config per producer, per egress type) fits documents more naturally than a fixed schema anyway. |

**Advantages:** Realtime listener is load-bearing for the gateway's zero-external-call hot path; serverless, no capacity planning for what is genuinely low, bursty write volume.

---

## 11. Data catalog — Knowledge Catalog (GCP-native)

**What it is:** An org-wide, searchable catalog of every data element the platform ingests — schema history, storage location, active consumption patterns, and current access — plus the entry point consumers use to browse and request access.

**Naming note, since this product renamed recently:** the original standalone **Data Catalog** was deprecated January 30, 2026 and fully shut down starting June 1, 2026 — do not build against it. **Dataplex Universal Catalog** was itself renamed **Knowledge Catalog** on April 10, 2026 (APIs, `gcloud dataplex` commands, and client libraries kept their old names — only the product branding changed). Knowledge Catalog is what this section describes.

**How it works:**
- Knowledge Catalog auto-discovers BigQuery, Cloud SQL, Spanner, Pub/Sub, AlloyDB, Cloud Storage, and Dataproc natively. It does **not** auto-discover Confluent Cloud, since Kafka isn't a GCP resource. Every producer's schema/topic is registered as a **custom Entry** (a supported, typed feature of the catalog) by `saga.workflow`, at the same checkpoint that already writes to Firestore on a successful apply — one new write piggybacked on an existing step, not a new trigger.
- **The egress side closes this loop for free, on the GCP-native path.** Once the Confluent managed connector (§7) lands data in the producer's declared `storage_target` — BigQuery or Bigtable — Knowledge Catalog's native auto-discovery picks that resource up automatically, with zero code written by this platform. This is the asymmetry worth noticing: the Kafka/schema side needed a custom Entry write because Kafka isn't GCP-native; the storage side needs nothing at all, because it is.
- **Real-time is not achievable through Knowledge Catalog itself, and this is a Google platform constraint, not a design choice.** Documented sync latency: metadata/entries up to ~10 minutes, lineage graphs 30 minutes to 3 hours (up to 24 hours to fully populate). Firestore remains the genuinely real-time operational record the portal already depends on; Knowledge Catalog is a deliberately separate, near-real-time governance and discovery layer, fed from the same event but with its own freshness expectations.
- Lineage for the pull path gets picked up automatically, since Dataflow lineage tracking is GA. The push path (a producer's own app calling the gateway directly) isn't a tracked GCP pipeline, so it needs a custom lineage event via the Data Lineage API (`sourceType: CUSTOM`), written at the same saga checkpoint.
- **The object model, precisely:** an **Entry** is the canonical pointer to a data asset — governance never touches the underlying resource directly, only its Entry. An **Entry Type** can *require* specific Aspects before an Entry counts as complete. An **Aspect Type** is a schema-enforced template (typed fields — string, number, boolean, enum, nested records — not a free-form JSON blob); an **Aspect** is one filled-in instance of that template, attached to an Entry.
- **This is where SLA and scope commitments live, and it's a first-class part of the model, not a workaround.** A custom `DataContract` Aspect Type — `freshness_sla_minutes`, `uptime_commitment_pct`, `breaking_change_notice_days`, `support_contact`, all structured and independently searchable — gets attached to every producer's Entry, compiled from a new `.dataplatform/contract.yaml` (same PR-reviewed flow as `schema/`, `ingestion/`, `egress/`) and written by `saga.workflow` at the same checkpoint as everything else. Making it a *required* Aspect via the Entry Type turns "producer states their commitments" from a convention into something enforced — a Data Product literally cannot go live without it.
- **Aspects don't support file attachments** — worth knowing before assuming a full written SLA document lives directly in the catalog. The workaround, which is also arguably the more disciplined outcome: a `full_contract_document_url` field inside the same `DataContract` Aspect, pointing at a longer-form `CONTRACT.md` that the producer writes and versions in git alongside their schema, synced to a Cloud Storage bucket by the same saga step. The structured fields carry the queryable, enforceable numbers; the linked document carries fuller written context. Full breakdown of this object graph is in `data-platform-consumer-frontend-guide.md`.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| The deprecated standalone Data Catalog product | Being shut down; not a viable target for anything built now. |
| Build a custom catalog from scratch | Would mean re-implementing search, lineage graphing, access-request workflow, and a governance UI — all of which Knowledge Catalog already provides natively, including the access-request piece covered in §15. |
| Treat Firestore as the catalog | Firestore has no search, no lineage graph, no org-wide discovery UI, and — critically — no consumer-facing browse/request experience. It's the right tool for real-time operational state, the wrong tool for organization-wide discovery. |

**Advantages:** Zero custom search or lineage-graphing code to build or maintain; one write, piggybacked on an existing checkpoint, populates an org-wide governance surface; the freshness mismatch between Firestore and Knowledge Catalog is made explicit rather than papered over.

---

## 12. Cloud Scheduler + `/reconcile`

**How it works:** Hourly trigger → `/reconcile` runs `terraform plan` per producer and checks for a non-empty diff, rather than hand-diffing CSR against Firestore. A non-empty diff invokes `compensation.workflow` — the same one the saga's own failure branch uses.

**Alternatives considered:** A continuous drift-detection stream (e.g., watching Confluent Cloud audit logs) — rejected as significant added complexity for a failure mode (partial saga failure, or a manual out-of-band change) that's rare enough that an hourly check catches it well within an acceptable window.

**Advantages:** `terraform plan` is now the actual source of truth for drift — no separately-maintained diffing logic to keep in sync with what Terraform manages.

---

## 13. Ingestion Gateway (`ingestion-gateway/` — separate Cloud Run service, Go)

**What it is:** One generic ingestion endpoint for every producer — the single choke point for auth and schema enforcement before anything lands on the internal Kafka topic. Full design history — including a real post-launch redesign driven by producer feedback — lives in the dedicated `data-platform-ingestion-gateway-guide.md`; this section covers the current state only.

**How it works:** Validates incoming payloads via dynamic protobuf reflection against a descriptor cached from Firestore (never a producer-specific compiled type), wraps them in the Confluent wire format, and produces directly to Kafka — no Firestore call, no Confluent Cloud call, no Workflows call on this path, ever. Two supported transports, chosen per producer in `ingestion.yaml`'s `transport` field: **gRPC client-streaming** (the default, paired with platform-provided SDKs so producers never touch generated stubs directly) for producers needing sustained high-throughput publishing, and **REST/JSON with batching** for lower-volume producers who'd rather not take on streaming-gRPC setup at all. Both converge on the identical internal pipeline above.

**Worth being precise about:** Kafka brokers never validate anything against Schema Registry — a broker just stores whatever bytes it's given, with no concept of schemas at all. Schema Registry integration is entirely client-side. The gateway's dynamic validation, immediately before the produce call, is the *only* schema check anywhere in this hot path — the wire-format wrapping that follows it isn't a second validation, it's metadata embedded purely for whichever consumer reads the message later.

**No external load balancer is needed for this to work** — Cloud Run's own managed load balancer handles gRPC streaming and TLS termination natively. One is only worth adding for Cloud Armor, advanced custom-domain routing, or multi-region failover, none of which this needs today. Full reasoning in the dedicated document.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Unary gRPC as the only option (the original design) | Producer feedback surfaced three real problems — client-build burden, no self-service debugging, latency from likely per-request channel creation — that were tooling gaps around gRPC, not reasons to abandon it outright. See the dedicated document for the full redesign. |
| REST/JSON as the sole default | Ruled out once the requirement was clarified to sub-millisecond sustained throughput per producer — even batched JSON hits a real ceiling there that streaming gRPC doesn't. Kept as an opt-in for genuinely low-volume producers instead of the universal default. |
| A typed RPC method per producer | Every schema change would force a gateway redeploy — doesn't scale past a handful of producers. |
| Gateway calls Firestore per publish request, or polls Confluent Cloud directly | Puts an external network dependency on the highest-traffic path in the system; the local cache + listener removes it entirely. |
| External producer SA granted direct Kafka IAM | Exposes the internal broker to every producer's project and provides no place to enforce schema validation before data lands in Kafka. |
| Producer owns their own Kafka/Pub/Sub topic; platform pulls from it | A genuinely reasonable alternative for producers who'd rather integrate zero platform-specific code, at the cost of synchronous validation-at-write-time and a reversed trust direction (platform needs read access into producer-owned infrastructure). Already supported as a `pull`-method `source.type`, not a separate mechanism — see the dedicated document for the full tradeoff. |

**Advantages:** Zero external credentials on the hot path; one choke point for auth and schema enforcement; onboarding a new producer requires no gateway code change regardless of which transport or ingestion pattern they pick.

---

## 14. Portal (`portal/frontend` + `portal/backend`)

**What it is:** A fully read-only status and monitoring UI, entered through a home dashboard rather than a deep link — not a second control plane, and not a one-time deployment receipt. **This is producer-facing only** — it serves the team that owns a data contract, watching their own deployment. It's a genuinely separate surface from `access-portal/`, which serves *consumers* browsing and using other teams' data — see the dedicated Access Portal document rather than assuming this section covers that audience too.

**How it works:**
- `portal/frontend` is a React + TypeScript SPA, built with Vite into static files served from Cloud Storage + CDN. "Static hosting" describes how the app shell is *delivered*, not whether it shows live data — it's a client-side app polling a live API continuously.
- The page a producer actually bookmarks is the **home dashboard** (`/`) — a list of producer data contracts with a search box, matching on either `producer_id` or a human-readable name (recorded by the saga alongside the ID when it first writes a deployment record). A producer doesn't need to remember or construct a specific URL; they land on the dashboard and search.
- Selecting a result navigates (client-side, no page reload) to that producer's live status view. While a deployment is actively in progress, the frontend polls `portal/backend`'s status endpoint every 2–3 seconds, rendering each saga step as it completes — this works because `saga.workflow` already checkpoints to Firestore at every meaningful step (§8), so the data was always there; the frontend just needed to poll for it during this window. Once terminal, polling slows to every 30–60 seconds for ongoing health checks.
- **Deployment success alone isn't proof data is flowing**, and the portal treats it as a distinct claim. `portal/backend`'s `metrics-client/` queries **Confluent Cloud's own Metrics API** — topic-level produce rate, last-message timestamp — using a separate, read-only scoped key. This is the signal that finally shows a producer their data is actually moving through the platform, not just that resources exist.
- Portal access goes through the org's existing SSO; `portal/backend` scopes which `producer_id`s a given authenticated user can search for and view.
- **There is no write path of any kind.** No wizard, no PR creation, nothing. Every request this service handles is a read.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Portal calls the provisioning API directly to trigger changes | Two systems that can both independently provision infrastructure means two audit trails and two places for drift to creep in. |
| An ingress/egress wizard that opens PRs on a producer's behalf | Considered and removed — kept the portal's scope to exactly one concern (observability), rather than mixing a write-adjacent feature into what's meant to be a purely read-only tool. Non-technical onboarding remains an explicitly unsolved gap (§3) rather than something half-addressed here. |
| Deep-link bookmarking (`/deployments/{producer_id}`) as the assumed entry point | A producer realistically won't remember or reconstruct a specific producer ID URL days or weeks later. A home dashboard with search is what people actually bookmark and return to. |
| Browser talks to Firestore directly via its client SDK, for true push updates instead of polling | Requires writing and maintaining Firestore Security Rules to enforce per-producer access control at the document level — a second place authorization logic has to live — and puts a path to Firestore in client-side code, a materially bigger exposure surface than a server-to-server call. A 2–3 second poll is imperceptible to a human watching a status page; not worth the trade for a status UI. |
| Gateway periodically flushes its own per-producer activity counters to Firestore, as the liveness signal | Would mean touching the hot path's code, even for a batched background write. Confluent Cloud already tracks produce activity natively — querying its Metrics API gets the same signal with zero changes to the gateway. |

**Advantages:** Exactly one system of record — the portal genuinely cannot cause drift, since it cannot write anything; a real, continuously-checkable answer to "is my data actually flowing," not just a deployment receipt; an entry point that matches how people actually navigate back to a tool they used once weeks ago.

---

## 15. Access requests — Knowledge Catalog Data Products

**What it is:** The consumer-facing browse-and-request-access experience, and the mechanism that decides *how* a specific consumer gets to read a producer's data — deliberately not decided by the producer upfront (see the `egress.yaml` note in §3).

**How it works:**
- Each producer's egress target is registered as a **Data Product** in Knowledge Catalog — "a logical, curated collection of data assets, formally packaged to ensure it's discoverable, trusted, and accessible," with owner/approver emails configured at creation.
- A consumer browses Data Products, picks an **access group** — which represents a specific consumption pattern (direct access, a dedicated Kafka topic, a REST API) — and submits a request with a justification. This is a native, built-in workflow, not something built from scratch; Google even publishes an open-source reference UI (`knowledge-catalog-business-user-interface`) worth using as a starting point.
- The request routes to the data product's configured approvers, who approve or reject; the consumer gets tracked status (New → Approved, provisioning → Rejected) and an email notification.
- **On approval, provisioning branches by whether the target is GCP-native or not — and so does whether "who has access" needs any new bookkeeping.** For GCP-native resources (BigQuery, etc.), Knowledge Catalog's own backend appears to provision the IAM grant directly, and since that grant lives inside a resource Knowledge Catalog already governs, nothing further is needed — this is the one pattern where access tracking was already a solved problem. For Kafka-based patterns and the REST API pattern — none of them GCP-native, none of them visible to Knowledge Catalog on their own — a thin listener triggers the existing `terraform-apply-job`, applying the appropriate `infra/modules/consumption-patterns/` submodule (§16) for whichever access group was requested, and that same step **writes an access record back to Knowledge Catalog**. Without this, "who currently has access to this data" would quietly stop being answerable the moment a consumer picked anything other than direct access — worth stating plainly, since it's easy to build the provisioning half of this and forget the bookkeeping half.
- **Revocation is symmetric with approval, not a separate mechanism.** An active grant is just a row in the desired-state config `terraform-apply-job` reconciles against; removing it on revocation triggers the same job to tear down whatever was created — a new Kafka topic, a Dataflow relay job, a `rest-api` route, and the Knowledge Catalog access record for the two patterns that needed one — the same way removing any other declared resource would.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| Route every access request through a git PR, like schema changes | Deliberate divergence from the "everything goes through git" principle elsewhere in this system. Access requests are frequent and need fast turnaround — forcing a PR-review cycle onto every one would work directly against the self-service, browsable experience this is meant to provide. The meaningful check for an access request is a business/policy decision by the resource owner, not an engineering review of a diff. |
| Build a custom request/approval UI | Knowledge Catalog's Data Products feature already provides tracked requests, approver routing, and email notification natively — including a published open-source reference frontend. |

**Advantages:** A genuinely self-service discovery and request experience without building an approval workflow from scratch; GCP-native targets provision themselves; the one external case (Kafka) reuses `terraform-apply-job` rather than inventing a second provisioning path.

---

## 16. `egress-fanout-pipeline` — Dataflow relay for consumer-requested topics (Apache Beam, Java)

**What it is:** The mechanism behind the "new Kafka topic" and "new Pub/Sub subscription" consumption patterns — genuinely new infrastructure, provisioned per access grant, never speculatively.

**How it works:** The same Beam/Dataflow pattern as `pull-ingestion-pipeline` (§9), running in the opposite direction — instead of pulling from an external source into the platform, it relays from a producer's already-provisioned egress storage into a brand-new topic or subscription created specifically for one approved consumer. `infra/modules/consumption-patterns/kafka-mirror/` (or `pubsub-subscription/`) provisions both the new topic/subscription and this Dataflow job together, applied by `terraform-apply-job` on approval, torn down by the same job on revocation.

**Why this, and not a Confluent managed connector (the choice made for the producer's own sink in §7):** a managed connector is built for one fixed source and one fixed destination, living as long as the producer exists. This needs the opposite shape — an arbitrary source (whichever storage the producer happened to choose) relaying into a destination that's created and destroyed per individual consumer grant. Reusing the pull-ingestion pattern's per-grant Terraform lifecycle fits that shape; a managed connector's always-on model doesn't.

**Advantages:** One pipeline template, reused in both directions, rather than a second bespoke relay mechanism; lifecycle tied directly to the access grant that caused it to exist, so nothing outlives the permission that justified building it.

---

## 17. `egress-api` — generic REST consumption (Cloud Run service, Go)

**What it is:** The REST API consumption pattern's actual implementation — one generic Cloud Run service, mirroring `ingestion-gateway`'s design on the read side rather than provisioning a dedicated service per consumer or per dataset.

**How it works — deliberately config-driven, not code-driven:**
- The entire routing surface is one route: `GET /v1/:producer_id/:table`, written once and never touched again. Approving a REST API access request never deploys new code — it writes one Firestore document (`consumer`, `producer`, `table`), the same pattern as any other access grant.
- `handleTableQuery` resolves the caller's identity from their token, checks a cached Firestore grant (not a live lookup per request — same reasoning as the gateway's own cache), checks a cached BigQuery/Bigtable schema (via `adapters/`) for the table's real columns, and builds a **parameterized** query — never string-concatenated, since this is the one place in this design where careless input handling would be a real vulnerability, not just a bug.
- Any query parameter matching a real column becomes a filter; `limit`/`offset` are universal pagination the adapter always supports, unconditionally, regardless of schema — the two are handled by entirely separate code paths precisely because one is schema-derived and the other isn't.
- `GET /v1/:producer_id` is a discovery route listing only the tables that consumer's specific grant covers — the intersection of what actually exists (from the adapter's live schema check) and what they're approved for (from Firestore), never a hardcoded list.
- `GET /v1/:producer_id/openapi.json` exposes the identical schema as a machine-readable OpenAPI spec, so a consumer's own tooling (Postman, codegen) can consume it without any hand-maintained documentation.
- **Consumer-facing documentation is a live rendering of this same discovery call**, surfaced in `access-portal/` — a separate frontend from the producer-facing `portal/`, since the audience and purpose are entirely different (see the dedicated Access Portal document). Linked from the approval email, it's never a separately maintained doc that could drift from what's actually queryable.

**Alternatives considered:**

| Option | Why it lost |
| --- | --- |
| A dedicated Cloud Run service per consumer or per dataset | Would mean deploying new code for every access request — directly contradicts the "one generic mechanism, not one per instance" principle already established for the gateway. Also means N deploy pipelines, N sets of logs, and N cold-start profiles to operate instead of one. |
| Hand-written endpoints per producer's tables | Requires a platform engineer to write code every time any producer's schema changes — not self-service, and drifts from the actual schema the moment anyone forgets to update it. |

**A risk worth naming honestly, not just the service-count question:** the real contention risk isn't the API service — Cloud Run scales that fine — it's the **shared backend** (BigQuery slots, Bigtable read capacity) that one expensive query can exhaust regardless of how many API services sit in front of it. The mitigation lives in the adapter layer (per-grant query cost caps, e.g. `maximumBytesBilled`), not in splitting the service. There's also a natural pressure valve already built into this design: a consumer with genuinely heavy, sustained query needs is exactly the consumer who should pick **direct access** instead at request time — the consumption-pattern choice itself routes heavy load away from the shared service.

**Advantages:** Zero deploy per access grant; documentation that can't go stale, since it's the same live call the API itself answers; one place to enforce query cost governance across every producer and consumer.

---

## Design principles this all traces back to

| Principle | Where it shows up |
| --- | --- |
| One system of record | Git is the only place provisioning is *declared*; the portal never writes; Terraform state is the only place "what exists" is recorded |
| Control plane vs. hot path, strictly separated | Workflows/Terraform never appear on the publish path; Firestore is the only bridge |
| Revert is symmetric with create | Compensation is "apply the previous commit's generated vars," not bespoke undo code per resource |
| Least privilege by construction | External producers only ever get `run.invoker` on the gateway or the API; per-producer Terraform state prevents cross-producer blast radius |
| Fail fast, cheaply | `/ci` and validation reject bad input before any real execution starts |
| Safety nets have their own safety nets | Saga compensation catches in-flight failures; `terraform plan`-based reconciliation catches everything the saga couldn't see happen |
| One generic mechanism, not one per producer | The gateway's single `Publish` RPC and the pull pipeline's single Beam template both serve every producer through runtime parameters, never a compiled-in, producer-specific path. `egress-api`'s single route and `egress-fanout-pipeline` extend the same idea to the read side. |
| Not everything needs to go through git | Schema and infrastructure changes do, deliberately. Access grants deliberately don't — the right check for "should this consumer see this data" is a business decision made fast by an owner, not an engineering review of a diff. |
| Be honest about a dependency's own limits | Firestore is genuinely real-time; Knowledge Catalog is not, and that's stated plainly rather than papered over with an implied "seamless real time" that Google's own documented sync latency wouldn't support. |

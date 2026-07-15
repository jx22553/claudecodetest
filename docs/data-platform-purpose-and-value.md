# Why This Platform Exists

The other documents in this set explain *how* the platform works. This one explains *why it exists at all*, and why it's built this exact way rather than any of the simpler alternatives that came up along the way. If you need to explain this project to someone who will never read a Terraform module, this is the document to hand them.

---

## The problem, stated plainly

Before this platform, making data available to another team looks like this: someone emails or Slacks a request, an engineer on the producing team hand-builds a one-off export, nobody documents the schema anywhere central, nobody knows who else is depending on it, and six months later someone changes a column name and breaks three things nobody remembered existed. Multiply that by every producer-consumer pair in an organization, and what you have isn't a data platform — it's tribal knowledge held together by Slack history.

This platform exists to replace that with something with three properties the ad hoc version never has: **discoverable** (you don't need to know someone to find the data), **governed** (access is requested and granted deliberately, not copy-pasted), and **trustworthy** (a schema change goes through review, a broken deployment reverts itself, and "the data is flowing" is a claim you can verify, not just assume).

---

## Who this is actually for

Four different people experience this platform completely differently, and the design only makes sense once you see it through each of their eyes.

### Persona 1: The data producer

A backend engineer on, say, the orders team. They don't think of themselves as "a data platform user" — they think of themselves as someone who owns a service that happens to generate data other people want. Their actual goals: get this done quickly, don't become the permanent point of contact for every future integration request, and not accidentally break something for a consumer they've never met.

**What "great" looks like for them:** they run `datapltfm init`, write one `.proto` file describing their event, fill in two short YAML files (where does this land, is it push or pull), open a PR. The PR shows them exactly what will be created before anyone approves it. Someone reviews and merges. They watch a status page tick through each provisioning step live, and a few minutes later see actual proof — a message count, a timestamp — that data is moving, not just that a Terraform apply succeeded. From that point on, they never think about it again unless something breaks, and if something *does* break, the platform already tried to fix it before they even got paged.

### Persona 2: The data consumer

An analyst or engineer on a different team — say, finance — who's heard the orders team has data they need but has never talked to anyone on that team. Their goals: find out what exists without asking around, understand it well enough to trust it before they build on it, and get access without filing a ticket and waiting a week for a platform engineer to hand-build something.

**What "great" looks like for them:** they search a catalog, find the orders data product, read its description and see when it was last updated. They pick *how* they want to consume it — a one-off SQL query, a live stream, an API — based on what their own use case actually needs, not based on whatever the producer happened to expose. They submit a request with a one-line justification, get approved same-day by the actual data owner, and land on a page that already shows them exactly what they can query, with a working example filled in with their own real values. They're calling real data within the hour, not the week.

### Persona 3: The platform team

The small team that built and runs all of this. Their goal, above all: **the number of producers and consumers must be able to grow without the size of this team growing at the same rate.** If every new producer needs a bespoke Terraform config, or every access request needs an engineer to hand-wire a connection, the platform team becomes the bottleneck the whole thing was supposed to eliminate.

**What "great" looks like for them:** a new producer or a new consumption pattern is a config change, not new code. Policy — "never allow a literal credential in a config file," "never let CI mutate infrastructure" — gets written once and enforced everywhere automatically, not re-reviewed by a human on every single PR. When something drifts (a manual change outside the normal flow, a partially-failed deployment), reconciliation catches and fixes it on its own schedule, not because someone happened to notice.

### Persona 4: Governance and compliance

Someone who needs to answer, credibly, "who has access to what, and can you prove it." Their goal isn't speed — it's a defensible, always-current answer they can produce without interviewing five different teams.

**What "great" looks like for them:** every schema change has a PR, a reviewer, and a timestamp in git — nothing changes without an audit trail. Every access grant, whether it went through native GCP IAM or something custom-built, ends up reflected in one catalog they can query, so "who can see this data right now" is a real-time answer, not an email chain.

---

## Why it's built this exact way — tying the design back to the people it serves

Every major architectural choice made across the rest of these documents traces back to one of these four people:

- **Git as the only way to change a contract** exists for Persona 1 (a PR they can trust wasn't silently overridden) and Persona 4 (an audit trail that doesn't depend on anyone's memory) simultaneously.
- **Generic mechanisms — one gateway, one egress API, one Terraform module family — instead of bespoke code per producer** exists entirely for Persona 3. It's the only way the platform scales without the team scaling linearly alongside it.
- **The control plane and the hot path never depending on each other** exists for Persona 1 specifically — a producer's pipeline staying up during a platform deployment, or a platform outage, is the difference between "the platform is invisible infrastructure" and "the platform is a thing I'm scared of."
- **Consumption pattern chosen by the consumer, not decided by the producer upfront** exists entirely for Persona 2 — because the producer genuinely cannot know every future use case, and guessing wrong means either over-building unused infrastructure or under-serving a real need.
- **Reconciliation running independently of any single deployment** exists for Persona 3 and Persona 4 together — it's the thing that makes "trustworthy" true even when something fails silently, not just when everything goes right.

If you take one design choice out of this system without understanding which of these four people it was protecting, you'll usually find you just made the platform worse for someone, even if it looks simpler on paper.

---

## What is a data product?

This term gets used constantly in the other documents, so it's worth defining precisely rather than assuming it's obvious. **A data product, in this platform, is a bounded set of data with a single named owner, a versioned and enforced schema, discoverable metadata, and at least one supported way for someone else to consume it — treated with the same rigor as a piece of software with real users, not as an incidental byproduct of some other system.**

Concretely, that means every data product here has:

- **An owner** — a specific team accountable for its schema, its uptime, and answering access requests. "Nobody" is not a valid answer to "who owns this."
- **A contract, not just a shape** — the schema is declared, versioned, and compatibility-checked before any change ships, the same way an API contract would be, not something a consumer has to reverse-engineer from what a table happens to look like today.
- **Discoverability** — it's findable in the catalog by anyone with a legitimate reason to look, not findable only by asking around.
- **A defined, governed way to be consumed** — direct access, a stream, an API — chosen deliberately per consumer, not an ad hoc export someone was talked into building once.

## Deciding what should actually become a data product

Not everything a service produces deserves to go through this entire machinery, and treating every internal table as a formal data product is its own kind of over-engineering — it adds ceremony (a proto schema, a reviewed PR, ongoing infrastructure) to things that don't need it. Use this as the actual test before onboarding something:

1. **Is there a real consumer outside the producing team — today, or credibly soon?** If the honest answer is "maybe someday," it's not ready. Onboarding ahead of actual demand means maintaining a contract and infrastructure for a consumer who may never show up.
2. **Can you name an owner who will actually maintain it?** Not a team in the abstract — a specific group who will review schema-change PRs and respond to access requests. If nobody currently expects to do that job, the platform can't manufacture accountability that doesn't exist yet.
3. **Is the data stable enough to be worth a versioned contract?** Something that's still being actively reshaped week to week internally isn't ready for consumers to build against — a churning schema behind a stable-looking contract just moves the pain downstream instead of removing it.
4. **Does it need access governed at all?** If the honest answer is "everyone in the company should just see this," the heavy machinery here (access requests, approval workflows, catalog entries) may be more ceremony than the situation warrants — a simpler, fully open pattern might genuinely be the better fit.
5. **Is this an ongoing need, or a one-time pull?** This platform is built for continuously fresh data with a live pipeline behind it. A single historical export for one analysis doesn't need a producer contract, a Kafka topic, and a catalog entry — that's solving a permanent-infrastructure problem for a temporary need.

If the answer to (1) and (2) is genuinely yes, it belongs here. If either is still "not yet," the right move is to wait, not to onboard early and hope an owner or a consumer materializes later.

# The Observability Portal

This document explains one piece of the platform in isolation: the portal. Everything else in the system exists to provision infrastructure; the portal's only job is to let a producer *see* what's happening to their data, from the moment they merge a PR through however long that pipeline keeps running afterward. It has no other job — there is no write path anywhere in it.

---

## What the portal is actually for

Picture the producer's actual experience. They've just merged a PR that adds a new Kafka topic and a new schema. Two questions matter to them, in this order:

1. **"Is my thing being set up right now, and did it work?"** — a short-lived, urgent question. They want to watch it happen.
2. **"Is my data actually flowing, and is it still healthy?"** — a question they'll want to ask again next week, next month, any time something looks off downstream, with no memory of any specific URL from the day they merged.

The portal exists to answer both, and the design of every piece below traces back to one of these two questions — including the decision that the *entry point* is a searchable home dashboard, not a link a producer is expected to remember.

---

## The frontend

### Tech stack

React + TypeScript, built with **Vite** into plain HTML/CSS/JS files, served from **Cloud Storage + a CDN**. No backend framework rendering pages on the fly — the files a browser receives are the same for every visitor.

### Why static hosting still works for something that feels live

The key idea, worth restating plainly: **"static" describes how the files are built and delivered, not whether the page shows live data.** The build happens once, whenever the platform team ships a new version of the portal. What happens *every time a producer opens the page* is completely different — and that's where the actual behavior lives:

1. The browser downloads the same unchanging `index.html` / `app.js` / `style.css` from the CDN — instant, cached at edge locations worldwide, no server computing anything.
2. Once that JavaScript starts running *inside the browser*, it makes its own live HTTP calls to `portal/backend` to fetch real, current data.

So the "dashboard that updates every few seconds" feeling comes entirely from step 2 — ordinary JavaScript calling an API on a timer — not from anything the server did differently per request.

### What a producer actually bookmarks: the home dashboard, not a deep link

Assuming a producer bookmarks a specific `/deployments/{producer_id}` URL doesn't hold up — nobody reliably remembers or reconstructs a specific ID weeks later. The page people actually bookmark is the **home dashboard**, at the root path:

- It lists producer data contracts, with a **search box** matching on either the exact `producer_id` or a human-readable name.
- A producer who only vaguely remembers "the orders team's thing" can search by name and still find it — the saga records a readable name alongside the ID the first time it writes a deployment record, specifically so this works.
- Selecting a result from the search navigates, client-side, to that producer's live status view — no page reload, no new file fetched from the CDN, just React swapping what's rendered.

This is also why the earlier "how does a bookmarked deep link resolve against static files" question doesn't even need to come up for the common case anymore — the one URL that matters, the home dashboard, is a real file every time.

### Live polling — two different rhythms for two different questions

This maps directly back to the two questions from the top of this document:

- **While a deployment is actively running** (question 1), the frontend polls `portal/backend` every **2–3 seconds**, rendering each saga step — provision topic, register schema, write Firestore — as it completes. This works because `saga.workflow` was already writing a checkpoint to Firestore at every one of those steps; the frontend is just the first thing to actually watch for them in near-real-time.
- **Once deployment reaches a terminal state** (question 2), the page doesn't stop being useful — it keeps polling, just on a slower, cheaper rhythm (every 30–60 seconds), now checking ongoing health rather than deployment progress.

---

## The backend

`portal/backend` is one Cloud Run service with two distinct jobs inside it, each reading from a different source. There is no third job that writes anything — that's a deliberate, load-bearing fact about this service, not an omission.

### `status-api/`

Reads Firestore's deployment records and saga checkpoints, and exposes the **list/search endpoint** that powers the home dashboard — matching on `producer_id` or the recorded name. This is what answers question 1 ("what step is my deployment on, did it succeed") and is also what makes the dashboard's search box actually work.

### `metrics-client/`

Queries **Confluent Cloud's own Metrics API** — topic-level produce rate, last-message timestamp — using a separate, read-only scoped API key. This answers question 2, and it's worth being explicit about why it exists as a distinct thing: **a successful deployment only proves resources exist, not that data is moving.** Terraform apply succeeding tells you the topic and schema were created correctly. It tells you nothing about whether a producer's app (or a provisioned Dataflow pull job) has actually sent a single message since. `metrics-client` is the only place in the entire system that answers "is this actually working, right now," and it gets that answer without touching the gateway's hot path at all — Confluent Cloud was already tracking this.

### Auth and scoping

Producers authenticate through the organization's existing SSO — no separate login system. `status-api` and `metrics-client` both check the authenticated user's identity against which `producer_id`s their team owns before returning anything, so one team can't browse another team's deployment internals or throughput — including through the dashboard's search, which only ever returns results the requester is allowed to see.

---

## Putting it together: what actually happens, start to finish

Following one producer's real path through the system:

1. Their PR merges. `saga.workflow` starts running, writing checkpoints to Firestore as it goes.
2. They open the portal's **home dashboard**, which they bookmarked once, long ago.
3. They type "orders" or their `producer_id` into the search box. `status-api` returns matching results, scoped to what their SSO identity is allowed to see.
4. They select their result. The frontend navigates client-side to that producer's live status view and immediately starts polling `status-api` every 2–3 seconds. They watch "provision topic" go green, then "register schema," then "write Firestore" — live, without refreshing anything.
5. The saga reaches `deployed`. The frontend notices the terminal state and slows its polling to every 30–60 seconds.
6. From this point, `metrics-client` starts showing produce activity on the topic — a rising message count, a recent last-message timestamp — the first real evidence that data is flowing, not just that infrastructure exists.
7. They close the tab. A week later, someone else on their team opens the same bookmarked home dashboard, searches by name (not knowing the exact ID), finds the same producer, and sees current throughput — nothing expired, nothing needed to be remembered beyond "search the dashboard for our name."

That's the entire lifecycle. There is no step 8 where the portal does anything besides show data.

---

## What the portal deliberately does not do

Worth being explicit, since it's easy to assume otherwise from how much this page can show:

- It never triggers a Terraform apply, calls `provisioning-api`'s `/cd` route, or starts a GCP Workflows execution.
- It never writes to Firestore. Every read is read-only.
- It never opens a pull request, has no wizard, and has no integration with GitHub of any kind. If a producer wants to change their contract, they go back to git — the portal doesn't offer a shortcut.
- It never calls the ingestion gateway. It has no role in the hot path at all — it's purely an observer of what the hot path and control plane are already doing.

This is what keeps the portal from ever becoming a second, competing system of record — it's a window onto the rest of the platform, not a second way to operate it. The honest cost of this scoping: a producer with no git experience has no on-ramp through this tool. That's an acknowledged, out-of-scope gap, not something this portal quietly half-solves.

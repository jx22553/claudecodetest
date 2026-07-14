# The Ingestion Gateway — Design History, Redesign, and Alternatives

This document exists because `ingestion-gateway` went through a real design revision after shipping, based on direct producer feedback — and that history is worth preserving rather than quietly overwriting, since the reasoning behind the change is as important as the change itself.

---

## What the gateway is, unchanged throughout all of this

One generic Cloud Run service, one route pattern, serving every producer through the same code path — the transport and framing changed, but this core design never did:

1. Resolve the caller's identity from their credential.
2. Look up a cached Firestore grant/schema record (never a live call per request).
3. Validate the payload via dynamic protobuf reflection against a cached descriptor — never a producer-specific compiled type.
4. Wrap it in the Confluent wire format.
5. Produce to the internal Kafka topic.

Nothing below changes that pipeline. What changes is only how bytes arrive at step 1.

---

## The original design: gRPC, and why it seemed right at the time

The initial reasoning: the schema is already protobuf, so gRPC gives producers a generated typed client "for free," and the wire-efficiency/HTTP-2-multiplexing benefit matters on a genuinely high-volume hot path — unlike `provisioning-api`, where the caller is a `curl` step in CI YAML and gRPC tooling would be pure friction.

That reasoning had a real gap: it assumed producer teams calling the gateway already have gRPC tooling, codegen pipelines, and channel-management experience sitting around. That assumption turned out to be wrong for this audience.

---

## The feedback that changed it

Three complaints came back from producer teams, independently:

1. **"We need to build a client just to call this."** Generating a gRPC client means `protoc`, per-language codegen tooling, `.proto` import management, and gRPC-specific auth/channel setup — real lift for a team that just wants to send an event.
2. **"We don't have control over it — when it doesn't work, we need the platform team's help."** gRPC isn't `curl`-able. Status codes aren't the HTTP codes every engineer already knows. Standard tools (Postman, browser devtools, most corporate proxies) don't handle it naturally. A producer misconfiguring something has no way to self-diagnose.
3. **"We're seeing latency issues."**

### Root-causing each one, not just accepting the symptom

The first two are real gaps in the *tooling around* gRPC, not something inherent to the protocol. The third is worth being precise about: switching transport doesn't automatically fix latency on its own. The most plausible cause, directly tied to complaint #1, is a hand-rolled client opening a **new channel per request** instead of reusing one long-lived channel — paying a full TLS + HTTP/2 handshake on every single call. That's not a gRPC-inherent cost; it's what happens when an unfamiliar team holds the tool wrong. This matters because it changes the fix: the answer isn't necessarily "abandon gRPC," it's "stop making producers hand-build gRPC clients."

---

## The constraint that ruled out a pure REST/JSON default: sub-millisecond throughput

Before finalizing a redesign, the requirement was clarified: assume any producer can be publishing new records at sub-millisecond intervals, sustained. At that rate, even aggressively batched REST/JSON runs into a real ceiling — JSON serialization is routinely 3-10x slower than protobuf binary for equivalent data, and even with keep-alive, each HTTP request still carries its own header/framing overhead. A producer would need to buffer and flush extremely frequently just to keep up.

**This is exactly the shape of problem gRPC client-streaming solves** — one long-lived connection, the producer pushes events onto it continuously, no per-message connection or header overhead. So gRPC wasn't the wrong tool; unary gRPC with no supporting tooling was.

---

## The actual redesign: keep streaming gRPC, fix the tooling gap directly

### 1. `rpc Publish(stream Event) returns (PublishSummary)` — client-streaming, not unary

The gateway's route signature changes from one-request-in-one-response-out to many-events-in-over-time, periodic-acks-out. The core pipeline (steps 1-5 above) doesn't change — only how many times it runs per connection.

### 2. Platform-provided SDKs — this is what actually fixes complaints #1 and #3

Producers never touch `protoc` or see a raw generated stub. They call `client.Publish(event)`; the SDK handles opening and **reusing** a stream, internal batching, and retries. There's nothing left to build — which directly kills complaint #1 — and the SDK's stream reuse is exactly what prevents the per-request-channel mistake that most plausibly caused complaint #3.

### 3. An explicit transport choice in `ingestion.yaml`, not a mandate

```yaml
method: push
transport: grpc-stream   # default; required above a documented throughput threshold
# transport: rest         # available for genuinely low-volume producers
```

Not every producer actually needs sub-ms sustained rates even though the platform has to be *capable* of it. A low-volume producer can choose plain REST/JSON (still with a batch endpoint, `POST /v1/publish/{producer_route}/batch`, and an `application/octet-stream` option for raw protobuf bytes without needing gRPC tooling) rather than pay streaming-gRPC's setup cost for a volume they'll never hit. Both transports converge on the identical internal pipeline — only the adapter parsing the incoming request differs, the same pattern already used for `egress-api`'s storage backend adapters.

---

## Do you need a load balancer for this?

No, and this is worth being precise about since it's easy to assume otherwise for something gRPC-shaped: **Cloud Run already puts a Google-managed load balancer in front of every service**, gRPC and streaming included — TLS termination, HTTP/2, and distribution across autoscaled instances all come for free the moment you deploy, no separate configuration. During autoscaling, that load balancer transparently opens new connections to new instances and sends `GOAWAY` to instances scaling down, invisible to the producer's client — meaning the SDK doesn't need custom reconnection logic for ordinary scaling events.

**The one real constraint:** Cloud Run's request timeout applies to the *whole stream* for a client-streaming RPC, up to a 60-minute maximum. The SDK should reconnect proactively (e.g., cycle the stream at 55 minutes if the timeout is set to 60) so a producer never sees or has to handle this at all.

**When you'd add an external Load Balancer anyway:** Cloud Armor (WAF/DDoS protection) requires one — it isn't available on the plain `*.run.app` endpoint. Same for more advanced custom-domain routing or multi-region failover. Not needed for gRPC streaming to function at all; worth adding only if you need one of those specific capabilities.

---

## Another alternative: the producer owns the topic

A different shape of solution altogether: instead of a producer calling the gateway at all — via any transport — the producer runs their **own** Kafka topic or Pub/Sub topic, and the platform reads *from* it, relaying into the internal topic. No SDK, no client, no gateway call of any kind on the producer's side.

**This isn't actually a new mechanism to build.** `ingestion.yaml` already supports `method: pull` with a `source.type` field — a producer-owned Kafka or Pub/Sub topic is just another valid `source.type`, alongside `api_endpoint`, read by the same `pull-ingestion-pipeline` Dataflow job already built for external sources. The honest way to frame this option is: **should a producer default to pull-from-their-own-topic instead of push-to-the-gateway?**

**What this genuinely buys a producer:** zero platform-specific integration work. They publish to infrastructure they already run, using tools they already know, and never write a line of platform-facing code. For a team that's already running Kafka or Pub/Sub internally for their own reasons, this could mean the entire "onboard to this platform" step is just a permissions grant.

**What it costs, stated honestly, not glossed over:**
- **Schema validation timing shifts from synchronous to asynchronous.** The gateway's push path rejects a bad payload immediately, at write time, before it ever exists anywhere durable. A pull-from-producer-topic path validates only when the platform's relay reads it — meaning invalid data can sit in the producer's own topic, undetected, until the relay catches up.
- **The trust direction reverses.** Every other pattern in this design has the platform granting a scoped credential *into* platform-owned infrastructure. This one requires the producer granting the platform read access *into infrastructure the producer owns and controls* — a different, and in some ways less containable, trust boundary.
- **It's still "one config per producer," which is fine — but worth naming.** The Dataflow relay pattern stays generic (one pipeline template, parameterized), so this doesn't reintroduce a fully bespoke per-producer integration. But each producer's topic does need its own connection configuration, which is real, ongoing surface area compared to the gateway's zero-config "any producer, same endpoint" model.

**Where this is the right call:** a producer who already operates Kafka/Pub/Sub infrastructure for other reasons, values zero platform-specific code over synchronous validation feedback, and is comfortable granting the platform read access into their own systems. **Where push (gRPC-stream or REST) remains the better default:** everyone else — synchronous validation at write time is a real safety property worth keeping as the default, and it's what makes `datapltfm publish --test`'s immediate, actionable feedback possible in the first place.

---
title: Agents draft. Humans decide.
description: Prepare, revise and submit emails for human approval with Countersign.
---

Countersign lets an agent prepare an email and a human decide what gets sent.
The human reviews the exact recipient and content. Approved revisions go through
Resend, and the agent can follow the review and delivery outcome.

## Get connected

1. Open the app and sign in with your preconfigured reviewer account.
2. Open **Connect your agent**, reveal the key and copy the setup prompt.
3. Give that prompt to your agent. It can discover the interface, create a draft
   and return a review link using only these docs.

Start with [your first five minutes](/getting-started/) for the full walkthrough,
or read the [agent workflow](/agent-workflow/) for authentication, retries and limits.

## Email and Resend

Approved HTML and plain text are stored before sending and never rerendered.
The send Worker uses the official Resend SDK with a stable idempotency key;
signed webhooks distinguish provider acceptance, delivery and bounce outcomes.
Unknown send outcomes stop for reconciliation rather than trigger a replacement.

Read the [project overview](/project/overview/#resend-integration-and-failure-handling) for the implementation and its
boundaries, or the [React Email example](/react-email/) for authoring both bodies.

## For agents

Start with [SKILL.md](/SKILL.md). Use the [API reference](/api-reference/) or
[OpenAPI JSON](/openapi.json) when you need request and response details.
The reviewer provides an agent key through Connect; no Resend key is needed.

## Review the engineering

The [project overview](/project/overview/) covers approval rules, recovery, setup,
verification and tradeoffs.

Sending is paused by default in the repository. Local automated provider tests
are separate from live deployment and delivery proof.

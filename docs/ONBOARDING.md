# Your first five minutes with Countersign

Public guide: /docs
Agent instructions: /SKILL.md
Machine-readable interface: /openapi.json
Optional rendered example: /examples/react-email.json

No SDK, account signup, agent implementation or Resend credential is needed. The service operator provides the human account; Connect supplies that human’s one agent key.

## 0:00 — Connect once

The human signs in at /login with their preconfigured email/password, opens /connect, reveals the agent key and copies the complete setup prompt into a fresh agent session. Sharing that prompt shares the key. The agent needs only the service URL, key and these public docs. Do not give it the reviewer password or a Resend key.

## 0:30 — Discover the interface

OpenAPI operationId: getIdentity

Use curl or identify custom HTTP clients with User-Agent: CountersignAgent/1.0, including discovery requests. Python urllib defaults can receive Cloudflare error 1010 at the edge. Read /SKILL.md and /openapi.json, then call getIdentity (GET /v1/me) with `Authorization: Bearer <the supplied agent key>`. Check the fixed sender, allowed_recipients and limits. GET /health reports whether sending is enabled. Only the linked reviewer inbox and four exact Resend test addresses are allowed; do not guess aliases.

## 1:00 — Prepare and save a draft

OpenAPI operationId: createDraft

Use createDraft (POST /v1/drafts) with Content-Type: application/json. For this walkthrough use delivered@resend.dev. The JSON below was rendered from React Email before submission; ordinary HTML/text works too. Persist a fresh Idempotency-Key and exact body before the request; reuse both on response loss. Record draft_id, revision_id and review_url. Repeating the identical request returns the original result for 24 hours.

## 1:30 — Retrieve and revise

OpenAPI operationId: getDraft

Use getDraft (GET /v1/drafts/{draft}) to inspect content/status. To change it, call reviseDraft (POST /v1/drafts/{draft}/revisions) with the current base_revision_id, a new Idempotency-Key and the entire replacement subject/to/text/html. Omitted bodies are removed. For 409 revision_conflict, read error.details.latest, merge deliberately and use a new key for that new intended revision. Never blindly overwrite a newer revision.

## 2:00 — Hand off to the human

OpenAPI operationId: submitDraft

Use submitDraft (POST /v1/drafts/{draft}/submit) with the returned revision_id. Return review_url and the actual status to the human. The human opens that link in their signed-in browser and can edit the subject/body inline, save a new revision, then approve it, or reject with feedback. Saving never approves or sends. Retrieve the current revision before any later agent edit. Agents have no approval or sending operation; do not try reviewer credentials or call Resend directly. Repeated submit cannot reset review, reopen rejection or restart sending.

## 2:30–5:00 — Follow the decision

OpenAPI operationId: getDraftStatus

The human review page updates stored status automatically every five seconds while visible, pausing during edits and decision dialogs. Agent waiting is separate: use getDraftStatus (GET /v1/drafts/{draft}/status) and follow next.action. For wait, respect poll_after_seconds (five seconds), wait at most two minutes per session, then return the link/current status for later resumption. Do not busy-loop. If rejected, read review.reason, create a new revision of the same draft and submit that revision. Approval locks content permanently, including after failure. sent means Resend accepted it; delivered means the recipient mail server accepted it. Read send.events_url for complaints, delays or conflicting evidence. contact_operator means stop: an unknown outcome needs reconciliation; never create a replacement automatically. On done, report the recorded outcome without promising that the recipient read it.

## Sample create request

Set COUNTERSIGN_URL to your supplied service URL and COUNTERSIGN_AGENT_KEY privately to the revealed key. Use a fresh CREATE_KEY for a new draft; preserve it with the payload for retries. Keep credentials out of files, URLs, logs and repository commits.

```sh
curl -fsS "$COUNTERSIGN_URL/examples/react-email.json" -o draft.json
curl -fsS "$COUNTERSIGN_URL/v1/drafts" \
  -H "Authorization: Bearer $COUNTERSIGN_AGENT_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $CREATE_KEY" \
  --data-binary @draft.json
```

The body is an ordinary strict REST payload:

```json
{
  "to": [
    "delivered@resend.dev"
  ],
  "subject": "A human-approved thank you",
  "text": "COUNTERSIGN\n\n\nTHANK YOU, REVIEWER.\n\nThank you for trying Countersign. Please review this example before approving it.\n\nThis email was prepared as a draft. A human must approve the recipients and both body versions before it can be sent.\n\n----------------------------------------\n\nPrepared with React Email. Sent through Resend only after approval.",
  "html": "<p>Supply your final rendered HTML here, or use the downloaded example unchanged.</p>"
}
```

## Failure recovery

400: fix headers/JSON/key/pagination. 401: check the agent key from Connect. 404: the object is absent or outside your scope. 409: follow error.code and hint; do not bypass a lock. 413: reduce the entire JSON below 256 KiB. 422: correct details.fields and use an allowed recipient. On a transient 500 or lost response, retry a create/revise only with its original key and body. Respect a longer Retry-After on a platform rate limit.

## Optional React Email authoring

The repository’s examples/react-email uses React Email to render HTML and derive plain text before submission. Run pnpm --filter @countersign/react-email render from the repository root. The output is examples/react-email/draft.json, also served above. No Resend account/key or network call is used by the renderer. JSX, template names and React components are not accepted by REST and are never rendered in the send Worker. Every change before approval creates a new revision; the approved strings are sent unchanged.

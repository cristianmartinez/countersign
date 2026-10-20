/** Public instructions: never interpolate credentials into this document. */
export function agentSkill(
  origin: string,
  sendingEnabled: boolean | null = false,
): string {
  return `---
name: countersign
description: Prepare and submit customer emails for mandatory human approval through Countersign.
---

# Countersign agent workflow

Base URL: ${origin}/v1
API reference: ${origin}/docs
OpenAPI: ${origin}/openapi.json
First five minutes: ${origin}/onboarding.md
Optional rendered React Email payload: ${origin}/examples/react-email.json
Use curl or send User-Agent: CountersignAgent/1.0 with your HTTP client, including public discovery requests. Python urllib's default user agent can receive Cloudflare error 1010 before reaching the app. This edge response does not indicate an invalid agent key.
Authenticate with Authorization: Bearer cs_agent_... using the key from the human's authenticated Connect page. Never put the key in URLs, email bodies or public files. You cannot approve, reject or send. Reviewer cookies do not authenticate the API.

${sendingEnabled === null ? `Check ${origin}/health for sending_enabled before promising a send. Approval records a durable send intent even when sending is paused. The live skill at ${origin}/SKILL.md reports the service’s current sending configuration. A sent status means provider acceptance, not delivery.` : sendingEnabled ? "Approved drafts are sent automatically. A sent status means provider acceptance, not delivery. Verified delivery events update the status; inspect send.events_url for complaint, delay and conflicting evidence." : "Development status: draft APIs and human review are available; the send worker is implemented but sending is paused. Approval creates a durable send intent. Do not promise delivery."}

1. GET /v1/me to verify identity and read the fixed sender and allowed recipients.
2. POST /v1/drafts with Content-Type: application/json and a unique Idempotency-Key. Example body:

\`\`\`json
{"to":["delivered@resend.dev"],"subject":"Thank you","text":"Thank you for reviewing this project.","html":"<p>Thank you for reviewing this project.</p>"}
\`\`\`

3. The response contains draft_id, revision_id, status and review_url. GET /v1/drafts/{draft_id} to inspect the current revision. GET /v1/drafts/{draft_id}/revisions and /revisions/{revision_id} for history.
4. POST /v1/drafts/{draft_id}/submit with {"revision_id":"the returned revision UUID"}. Repeating submit for the current revision returns its existing state, without restarting review or sending.
5. Return review_url to the human and report the actual state. Approved is not sent; sent means Resend acceptance; delivered means recipient mail-server acceptance, not that someone read the email.
6. GET /v1/drafts/{draft_id}/status and follow next. Poll wait states no faster than poll_after_seconds (normally 5), for at most two minutes per waiting session. Then return the review link and current state; resume only when asked. Never poll contact_operator work.
7. If rejected, read review.reason. POST /v1/drafts/{draft_id}/revisions with a new Idempotency-Key, base_revision_id=current_revision_id and a complete replacement of to, subject and bodies. Then submit the new revision.

# Mutation and content rules

- Create/revise require Idempotency-Key: 1–128 letters, digits, dots, underscores, colons, slashes or hyphens. Reuse the same key and identical body after a lost response. Successful results are retained for 24 hours, scoped by agent, operation and target. After expiry inspect state instead of blindly replaying old mutations.
- Exactly one To address. Omit from, cc, bcc, reply_to, attachments, react and template; unsupported fields are rejected, including empty/null values. The service fixes the sender. React Email is optional: render it locally and submit final HTML/text strings.
- to must be your configured reviewer inbox or one of delivered@resend.dev, bounced@resend.dev, complained@resend.dev, suppressed@resend.dev. Test aliases are not enabled yet. Plain addresses only, no display names. Whitespace is trimmed and the domain lowercased; mailbox case/dots/plus tags must otherwise match exactly.
- Subject: 1–200 Unicode code points, no line breaks. Supply text, html or both, at least one nonempty. Each body: at most 100 KiB UTF-8. Entire JSON request: at most 256 KiB. Bodies are never truncated or rerendered during sending.
- Revisions are full replacements. Editing during review cancels the pending review. From approval onward drafts are locked, including after failure: revisions return 409 invalid_state.
- Never create a replacement draft automatically after failure. Unknown outcomes have send.needs_reconciliation=true and next.action=contact_operator: delivery is uncertain, and an operator must reconcile before another send.

# Lists and errors

GET /v1/drafts accepts status, limit (integer 1–100, default 20) and cursor. Revision history accepts limit/cursor. Responses contain items and next_cursor (null at the end). Pass cursors unchanged and URL-encoded with the same collection/filters. Cursors never grant access to another agent's objects.

A human may edit the subject/body before approval, creating a new current revision awaiting review. Revision detail/history include nullable author_reviewer_id; when present, the reviewer authored that revision, while author_agent_id retains the owning agent. Always read the current revision before revising.

Errors contain error.code, message, hint and details. 400 bad_request: fix JSON, headers, pagination or cursor. 401 unauthorized: check the agent credential. 404 not_found: no accessible object. 409 revision_conflict: read details.latest.revision, merge against current_revision_id and retry a new intended revision with a new key. 409 idempotency_conflict: same key was used for different content. 409 invalid_state: inspect status; do not bypass approval locks. 413 payload_too_large: reduce the whole request. 422 validation_error: correct details.fields. For transient 500 errors retry with the same mutation key/body. Respect Retry-After if a platform rate limit occurs.

Delivery evidence: GET /v1/drafts/{draft_id}/events (also linked by send.events_url). Lists use limit/cursor like revisions. Events are ordered by occurred_at then ID descending and include bounded detail summaries; the service retains full verified payloads. Bounce outranks failure/suppression, then delivery, then sent, regardless of arrival order. Complaint/delay are details only. A sent event alone cannot clear needs_reconciliation. Never create a replacement automatically.

React Email is optional: render HTML and derive plain text before creating the draft. The repository example lives in examples/react-email; run pnpm --filter @countersign/react-email render. REST accepts the resulting strings, not JSX or template references. Preview restrictions affect display only; approved strings are sent unchanged.
`;
}

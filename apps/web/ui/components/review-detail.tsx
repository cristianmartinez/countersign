/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import type { ReviewerReads, AgentReads, RevisionRow } from "@countersign/db";
import { diffLines } from "diff";
import {
  ArrowLeft,
  RefreshCw,
  Mail,
  ShieldCheck,
  History,
  Eye,
  Code,
  FileText,
  ChevronDown,
  Send,
} from "lucide-react";
import { Collapsible } from "@base-ui/react/collapsible";
import { Badge } from "../../src/components/reui/badge";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "../../src/components/reui/alert";
import { Button } from "../../src/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../../src/components/ui/card";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../src/components/ui/tabs";
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "../../src/components/reui/timeline";
import { RejectRevision } from "./reject-revision";

export type ReviewEditorProps = {
  current: RevisionRow;
  preview: string | null;
  action: string;
  csrf: string;
  onCancel: () => void;
};

export type ReviewDetailProps = Awaited<ReturnType<ReviewerReads["detail"]>> & {
  preview: string | null;
  csrf: string;
  events: Awaited<ReturnType<AgentReads["listDeliveryEvents"]>>;
  olderEvents: string | null;
  sendingEnabled: boolean;
  renderEditor?: (props: ReviewEditorProps) => ReactNode;
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "in_review"
          ? "warning-light"
          : status === "sent" || status === "delivered"
            ? "success-light"
            : ["failed", "bounced", "rejected"].includes(status)
              ? "destructive-light"
              : "secondary"
      }
    >
      {status === "drafted" ? "draft" : status.replaceAll("_", " ")}
    </Badge>
  );
}

function DecisionFields({
  csrf,
  revision,
  hash,
}: {
  csrf: string;
  revision: string;
  hash: string;
}) {
  return (
    <>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="revision_id" value={revision} />
      <input type="hidden" name="content_hash" value={hash} />
    </>
  );
}

function Difference({
  label,
  before,
  after,
}: {
  label: string;
  before: string | null;
  after: string | null;
}) {
  const changes = diffLines(before ?? "", after ?? "", {
    timeout: 50,
    maxEditLength: 2000,
  });

  return (
    <div className="space-y-3">
      <h3>{label}</h3>
      {before === null && after !== null && <p>Body added</p>}
      {before !== null && after === null && <p>Body removed</p>}
      {changes ? (
        <pre className="diff">
          {changes.map((part, index) =>
            part.added ? (
              <ins key={index}>{part.value}</ins>
            ) : part.removed ? (
              <del key={index}>{part.value}</del>
            ) : (
              part.value
            ),
          )}
        </pre>
      ) : (
        <>
          <p>
            Comparison exceeds the display budget. Inspect both versions below.
          </p>
          <h4>Previous</h4>
          <pre>{before ?? "(not supplied)"}</pre>
          <h4>Current</h4>
          <pre>{after ?? "(not supplied)"}</pre>
        </>
      )}
    </div>
  );
}

function FieldChange({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  return (
    <p>
      <strong>{label}: </strong>
      {before === after ? (
        <span>Unchanged</span>
      ) : (
        <>
          <del>{before}</del>
          {" → "}
          <ins>{after}</ins>
        </>
      )}
    </p>
  );
}

function Comparison({
  current,
  previous,
}: {
  current: RevisionRow;
  previous: RevisionRow | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="m-0 text-base">Revision comparison</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {previous ? (
          <>
            <p>
              {`Compared with revision ${previous.number}. Approval covers the complete displayed revision, not just these changes.`}
            </p>
            <FieldChange
              label="Sender"
              before={previous.sender}
              after={current.sender}
            />
            <FieldChange
              label="Recipient"
              before={previous.recipient}
              after={current.recipient}
            />
            <FieldChange
              label="Subject"
              before={previous.subject}
              after={current.subject}
            />
            {(previous.text_body !== null || current.text_body !== null) && (
              <Difference
                label="Plain text changes"
                before={previous.text_body}
                after={current.text_body}
              />
            )}{" "}
            {(previous.html_body !== null || current.html_body !== null) && (
              <Difference
                label="HTML source changes"
                before={previous.html_body}
                after={current.html_body}
              />
            )}
          </>
        ) : (
          <p className="m-0 text-muted-foreground">Initial revision</p>
        )}
      </CardContent>
    </Card>
  );
}

function EventTime({ value }: { value: number }) {
  const date = new Date(value);

  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
      })}{" "}
      UTC
    </time>
  );
}

function SendingStatus({
  status,
  sendingEnabled,
}: Pick<ReviewDetailProps, "status" | "sendingEnabled">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <h2 className="m-0 flex items-center gap-2 text-base">
            <Send className="size-4 text-muted-foreground" aria-hidden="true" />
            Sending status
          </h2>
          <StatusBadge status={status.delivery_status ?? status.send_state!} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!sendingEnabled &&
          ["queued", "retry_wait"].includes(status.send_state!) && (
            <p className="m-0 text-sm text-muted-foreground">
              Dispatch paused. No new send attempts will run.
            </p>
          )}
        {status.last_error && (
          <p className="m-0 text-sm wrap-anywhere text-destructive">
            {status.last_error}
          </p>
        )}
        {status.needs_reconciliation === 1 && (
          <Alert variant="warning">
            <AlertDescription>
              Needs reconciliation: delivery is unknown. Contact the operator
              before any replacement email.
            </AlertDescription>
          </Alert>
        )}
        <Collapsible.Root>
          <Collapsible.Trigger className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Sending details
            <ChevronDown
              className="size-4 transition-transform group-data-[panel-open]:rotate-180"
              aria-hidden="true"
            />
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <dl className="m-0 mt-4 flex flex-col gap-3 rounded-none border-0 border-t bg-transparent p-0 pt-4 text-sm shadow-none">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Send attempts</dt>
                <dd className="m-0 tabular-nums">
                  {status.send_attempts ?? 0}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground">Resend email ID</dt>
                <dd className="m-0 wrap-anywhere font-mono text-xs">
                  {status.resend_email_id ?? "No provider receipt"}
                </dd>
              </div>
              {status.send_updated_at !== null && (
                <div className="space-y-1">
                  <dt className="text-muted-foreground">Last activity</dt>
                  <dd className="m-0 text-xs">
                    <EventTime value={status.send_updated_at} />
                  </dd>
                </div>
              )}
            </dl>
          </Collapsible.Panel>
        </Collapsible.Root>
      </CardContent>
    </Card>
  );
}

function DeliveryEvents({
  events,
  olderEvents,
}: Pick<ReviewDetailProps, "events" | "olderEvents">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <h2 className="m-0 flex items-center gap-2 text-base">
            <History
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            Delivery events
          </h2>
          <span className="text-xs font-normal tabular-nums text-muted-foreground">
            {events.length}
            {olderEvents ? "+" : ""}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length ? (
          <Timeline
            value={events.length}
            render={<ol aria-label="Delivery events" />}
          >
            {events.map((event, index) => (
              <TimelineItem key={event.id} step={index + 1} render={<li />}>
                <TimelineSeparator className="bg-border" />
                <TimelineIndicator className="border-border bg-card" />
                <TimelineTitle
                  title={event.type}
                  className="m-0 leading-4 capitalize"
                >
                  {event.type.replace(/^email\./, "").replaceAll("_", " ")}
                </TimelineTitle>
                <TimelineContent className="mt-1 text-xs">
                  <EventTime value={event.occurred_at} />
                </TimelineContent>
                {event.detail && (
                  <TimelineContent>
                    <details className="mt-2">
                      <summary className="w-fit cursor-pointer text-xs">
                        Event details
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap wrap-anywhere">
                        {event.detail}
                      </pre>
                    </details>
                  </TimelineContent>
                )}
              </TimelineItem>
            ))}
          </Timeline>
        ) : (
          <p className="m-0 py-2 text-sm text-muted-foreground">
            No delivery events received.
          </p>
        )}
        {olderEvents && (
          <Button
            nativeButton={false}
            render={<a href={olderEvents} />}
            variant="outline"
            size="sm"
            className="mt-4"
          >
            Older delivery events
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function ReviewDetail({
  agent,
  status,
  current,
  previous,
  history,
  preview,
  csrf,
  events,
  olderEvents,
  sendingEnabled,
  renderEditor,
}: ReviewDetailProps) {
  const [editing, setEditing] = useState(false);

  const isCurrent = current.id === status.current_revision_id;

  const canDecide = isCurrent && status.status === "in_review" && !editing;
  const canEdit =
    isCurrent && ["drafted", "in_review", "rejected"].includes(status.status);

  const currentUrl = `/review/drafts/${status.id}`;

  const displayedUrl = isCurrent
    ? currentUrl
    : `${currentUrl}?revision=${current.id}`;

  return (
    <div
      className="space-y-6"
      data-review-editing={editing ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          nativeButton={false}
          render={<a href="/review" />}
          variant="ghost"
          size="sm"
        >
          <ArrowLeft aria-hidden="true" />
          Back to emails
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={status.status} />
          <Badge variant="secondary">Revision {current.number}</Badge>
          <span className="text-xs text-muted-foreground">
            By {current.author_reviewer_id ? "Reviewer" : agent.name}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            nativeButton={false}
            render={<a href={displayedUrl} />}
            variant="outline"
            size="sm"
          >
            <RefreshCw aria-hidden="true" />
            Refresh status
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        <h1 className="m-0 text-2xl font-semibold tracking-tight wrap-anywhere sm:text-3xl">
          {current.subject}
        </h1>
      </div>
      {!isCurrent && (
        <Alert variant="warning" role="status">
          <History aria-hidden="true" />
          <AlertTitle>Historical revision</AlertTitle>
          <AlertDescription>
            Historical revision: decisions are disabled.{" "}
            <a href={currentUrl}>Review current revision</a>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 className="m-0 text-base">Message details</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="m-0 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-none border-0 bg-transparent p-0 text-sm shadow-none sm:grid-cols-[4rem_minmax(0,1fr)]">
                <dt>From</dt>
                <dd className="m-0 wrap-anywhere">{current.sender}</dd>
                <dt>To</dt>
                <dd className="m-0 font-medium wrap-anywhere">
                  {current.recipient}
                </dd>
                <dt>Subject</dt>
                <dd className="m-0 wrap-anywhere">{current.subject}</dd>
              </dl>
            </CardContent>
          </Card>
          {editing ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2 className="m-0 text-base">Email content</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {editing &&
                  renderEditor?.({
                    current,
                    preview,
                    csrf,
                    action: `${currentUrl}/revise`,
                    onCancel: () => setEditing(false),
                  })}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Tabs
                defaultValue={current.html_body !== null ? "preview" : "text"}
              >
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                  <CardTitle>
                    <h2 className="m-0 text-base">Email content</h2>
                  </CardTitle>
                  {canEdit && !editing && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(true)}
                    >
                      Edit email
                    </Button>
                  )}
                  <TabsList aria-label="Email bodies" className="ml-auto">
                    {current.html_body !== null && (
                      <>
                        <TabsTrigger
                          value="preview"
                          aria-label="Preview"
                          title="Preview"
                        >
                          <Eye aria-hidden="true" />
                        </TabsTrigger>
                        <TabsTrigger
                          value="source"
                          aria-label="HTML"
                          title="HTML source"
                        >
                          <Code aria-hidden="true" />
                        </TabsTrigger>
                      </>
                    )}
                    {current.text_body !== null && (
                      <TabsTrigger
                        value="text"
                        aria-label="Text"
                        title="Plain text"
                      >
                        <FileText aria-hidden="true" />
                      </TabsTrigger>
                    )}
                  </TabsList>
                </CardHeader>
                <CardContent>
                  {current.html_body !== null && (
                    <>
                      <TabsContent
                        keepMounted
                        value="preview"
                        id="panel-preview"
                      >
                        <iframe
                          title="Email HTML preview"
                          sandbox=""
                          referrerPolicy="no-referrer"
                          srcDoc={preview ?? ""}
                          className="h-[32rem] w-full rounded-lg border bg-white"
                        />
                      </TabsContent>
                      <TabsContent keepMounted value="source" id="panel-source">
                        <pre className="m-0 h-[32rem] overflow-auto text-xs">
                          {current.html_body}
                        </pre>
                      </TabsContent>
                    </>
                  )}
                  {current.text_body !== null && (
                    <TabsContent keepMounted value="text" id="panel-text">
                      <pre className="m-0 h-[32rem] overflow-auto font-sans text-sm">
                        {current.text_body}
                      </pre>
                    </TabsContent>
                  )}
                </CardContent>
              </Tabs>
            </Card>
          )}
          {previous && (
            <details className="rounded-xl border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Compare revisions
              </summary>
              <div className="mt-4">
                <Comparison current={current} previous={previous} />
              </div>
            </details>
          )}
          {status.send_state && (
            <DeliveryEvents events={events} olderEvents={olderEvents} />
          )}
        </div>
        <aside
          aria-label="Review actions and history"
          className="min-w-0 space-y-6 lg:sticky lg:top-6"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 id="review-decision" className="m-0 text-base">
                  Review decision
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {editing && <Badge variant="secondary">Unsaved changes</Badge>}
              {status.decision && (
                <Alert
                  variant={
                    status.decision === "rejected" ? "warning" : "success"
                  }
                  role="status"
                >
                  <AlertTitle>Current revision: {status.decision}</AlertTitle>
                  {status.reason && (
                    <AlertDescription className="whitespace-pre-wrap wrap-anywhere">
                      {status.reason}
                    </AlertDescription>
                  )}
                </Alert>
              )}
              {canDecide ? (
                <>
                  <p className="m-0 text-sm leading-relaxed text-muted-foreground">
                    {sendingEnabled
                      ? "Approval sends this exact email and locks further edits."
                      : "Sending is paused. Approval queues this exact email and locks further edits."}{" "}
                    Check the recipient, HTML and text first.
                  </p>
                  <form
                    method="post"
                    action={`${currentUrl}/approve`}
                    className="m-0"
                  >
                    <DecisionFields
                      csrf={csrf}
                      revision={current.id}
                      hash={current.content_hash}
                    />
                    <Button type="submit" className="w-full">
                      Approve revision {current.number}
                    </Button>
                  </form>
                  <div className="[&>button]:w-full">
                    <RejectRevision
                      action={`${currentUrl}/reject`}
                      csrf={csrf}
                      revision={current.id}
                      hash={current.content_hash}
                      number={current.number}
                    />
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
          {status.send_state && (
            <SendingStatus status={status} sendingEnabled={sendingEnabled} />
          )}
          <section
            aria-labelledby="revision-history"
            className="rounded-xl border p-4"
          >
            <h2
              id="revision-history"
              className="m-0 mb-5 flex items-center gap-2 text-sm font-medium"
            >
              <History
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              Revision history
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {history.length}
              </span>
            </h2>
            <Timeline
              value={history.length}
              render={<ol aria-label="Revisions" />}
            >
              {history.map((revision, index) => {
                const selected = revision.id === current.id;
                const latest = revision.id === status.current_revision_id;
                const date = new Date(revision.created_at);

                return (
                  <TimelineItem
                    key={revision.id}
                    step={index + 1}
                    render={<li />}
                  >
                    <TimelineSeparator className="bg-border" />
                    <TimelineIndicator
                      className={
                        selected
                          ? "border-foreground bg-foreground"
                          : "border-border bg-background"
                      }
                    />
                    <TimelineTitle className="m-0 flex flex-wrap items-center gap-2 leading-4">
                      <a
                        href={
                          latest
                            ? currentUrl
                            : `${currentUrl}?revision=${revision.id}`
                        }
                        aria-current={selected ? "true" : undefined}
                        className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        Revision {revision.number}
                      </a>
                      {latest && (
                        <Badge variant="secondary" className="text-xs">
                          Latest
                        </Badge>
                      )}
                      {selected && (
                        <span className="text-xs font-normal text-muted-foreground">
                          Viewing
                        </span>
                      )}
                    </TimelineTitle>
                    <TimelineContent className="mt-1 text-xs">
                      {revision.author_reviewer_id ? "You" : agent.name}
                      {revision.number === 1
                        ? " · Initial revision"
                        : " · Edited"}
                    </TimelineContent>
                    <TimelineDate
                      dateTime={date.toISOString()}
                      className="mt-1 mb-0 font-normal"
                    >
                      {date.toLocaleString("en-GB", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "UTC",
                      })}{" "}
                      UTC
                    </TimelineDate>
                  </TimelineItem>
                );
              })}
            </Timeline>
          </section>
        </aside>
      </div>
    </div>
  );
}

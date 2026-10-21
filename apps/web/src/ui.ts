import {
  ReviewDetail,
  type ReviewDetailProps,
} from "../ui/components/review-detail";
import {
  ReviewTable,
  type ReviewTableProps,
} from "../ui/components/review-table";
import { LoginCard } from "./components/examples/c-card-12";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { raw } from "hono/html";
import { Button } from "./components/ui/button";
import { Badge } from "./components/reui/badge";
import { Alert, AlertTitle, AlertDescription } from "./components/reui/alert";
import { AppHeader } from "../ui/components/app-header";
import { CopyPrompt } from "../ui/components/copy-prompt";

// Explicit renderer boundary: Hono owns the document/forms; these components are
// real React, rendered to escaped HTML. Interactive islands hydrate in ui/client.tsx.
export function UiButton(props: ComponentProps<typeof Button>) {
  return raw(
    renderToStaticMarkup(createElement(Button, { type: "submit", ...props })),
  );
}

export function UiHeader(props: ComponentProps<typeof AppHeader>) {
  return raw(renderToStaticMarkup(createElement(AppHeader, props)));
}

export function UiStatus({ status }: { status: string }) {
  const variant =
    status === "delivered" || status === "sent"
      ? "success-light"
      : status === "failed" || status === "bounced"
        ? "destructive-light"
        : status === "in_review"
          ? "warning-light"
          : "secondary";

  return raw(
    renderToStaticMarkup(createElement(Badge, { variant, size: "lg" }, status)),
  );
}

export function UiNotice({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return raw(
    renderToStaticMarkup(
      createElement(
        Alert,
        { variant: "default", className: "my-6", role: "note" },
        createElement(AlertTitle, null, title),
        createElement(AlertDescription, null, description),
      ),
    ),
  );
}

export function UiCopyPrompt() {
  return raw(renderToString(createElement(CopyPrompt)));
}

export function UiLoginCard({ csrf }: { csrf: string }) {
  return raw(renderToString(createElement(LoginCard, { csrf })));
}

export function UiReviewTable(props: ReviewTableProps) {
  const data = JSON.stringify(props).replace(/</g, "\\u003c");

  return raw(
    `<div id="review-table-root">${renderToString(createElement(ReviewTable, props))}</div><script id="review-table-props" type="application/json">${data}</script>`,
  );
}

export function UiReviewDetail(props: ReviewDetailProps) {
  const data = JSON.stringify(props).replace(/</g, "\\u003c");

  return raw(
    `<div id="review-detail-root">${renderToString(createElement(ReviewDetail, props))}</div><script id="review-detail-props" type="application/json">${data}</script>`,
  );
}

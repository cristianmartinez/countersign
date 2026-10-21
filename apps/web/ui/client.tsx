import {
  ReviewDetail,
  type ReviewDetailProps,
} from "./components/review-detail";
import { ReviewTable, type ReviewTableProps } from "./components/review-table";
import { LoginCard } from "../src/components/examples/c-card-12";
/** @jsxImportSource react */
import { lazy, Suspense } from "react";
import { hydrateRoot } from "react-dom/client";
import { CopyPrompt } from "./components/copy-prompt";
import "./styles.css";
import { pollReview } from "./poll-review";

const reviewVersion = document.querySelector<HTMLElement>(
  "main[data-review-version]",
)?.dataset.reviewVersion;

const root = document.getElementById("copy-prompt-root");

async function copyPrompt() {
  // Read credentials only from this authenticated document on user action.
  const prompt = document.getElementById("setup-prompt");

  if (!(prompt instanceof HTMLTextAreaElement))
    return "Setup prompt unavailable";

  try {
    await navigator.clipboard.writeText(prompt.value);

    return "Copied";
  } catch {
    prompt.focus();

    prompt.select();

    return "Select and copy the prompt manually";
  }
}

if (root) hydrateRoot(root, <CopyPrompt copyPrompt={copyPrompt} />);

const loginRoot = document.getElementById("login-card-root");

const csrfInput =
  loginRoot?.querySelector<HTMLInputElement>('input[name="csrf"]');

if (loginRoot && csrfInput)
  hydrateRoot(loginRoot, <LoginCard csrf={csrfInput.value} />);

const reviewRoot = document.getElementById("review-table-root");

const reviewProps = document.getElementById("review-table-props");

if (reviewRoot && reviewProps?.textContent) {
  const root = hydrateRoot(
    reviewRoot,
    <ReviewTable {...JSON.parse(reviewProps.textContent)} />,
  );

  if (reviewVersion)
    pollReview<ReviewTableProps>(reviewVersion, (props) =>
      root.render(<ReviewTable {...props} />),
    );
}

const ReviewEditor = lazy(() => import("./components/review-editor"));

const detailRoot = document.getElementById("review-detail-root");

const detailProps = document.getElementById("review-detail-props");

if (detailRoot && detailProps?.textContent) {
  const render = (props: ReviewDetailProps) => (
    <ReviewDetail
      key={props.current.id}
      {...props}
      renderEditor={(editorProps) => (
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <ReviewEditor {...editorProps} />
        </Suspense>
      )}
    />
  );
  const root = hydrateRoot(
    detailRoot,
    render(JSON.parse(detailProps.textContent)),
  );

  if (reviewVersion)
    pollReview<ReviewDetailProps>(reviewVersion, (props) =>
      root.render(render(props)),
    );
}

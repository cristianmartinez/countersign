/** Five-second invalidation checks. Never fetch email content unless its version changed. */
export function pollReview<T>(
  initialVersion: string,
  render: (props: T) => void,
): () => void {
  let version = initialVersion;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  let stopped = false;
  let suspended = false;
  let delay = 5000;

  const busy = () =>
    Boolean(
      document.querySelector('[data-review-editing="true"], [role="dialog"]'),
    );

  function schedule() {
    if (!stopped && !suspended && document.visibilityState === "visible")
      timer = setTimeout(() => void check(), delay);
  }

  async function check() {
    if (
      stopped ||
      suspended ||
      document.visibilityState !== "visible" ||
      inFlight
    )
      return;

    if (busy()) {
      schedule();
      return;
    }

    const controller = new AbortController();
    inFlight = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);

    try {
      const response = await fetch("/review/updates", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "If-None-Match": JSON.stringify(version) },
        signal: controller.signal,
      });

      if (
        response.redirected ||
        response.status === 401 ||
        response.status === 403
      ) {
        stopped = true;
        return;
      }

      if (response.status === 304) {
        delay = 5000;
        return;
      }

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        const seconds = Number(retryAfter);
        const retryMs =
          retryAfter === null
            ? 0
            : Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(retryAfter) - Date.now();
        delay = Math.min(
          86_400_000,
          Math.max(
            Math.min(delay * 2, 60_000),
            Number.isFinite(retryMs) ? retryMs : 0,
          ),
        );
        return;
      }

      const update: { version: string } = await response.json();
      delay = 5000;

      if (update.version === version || busy()) return;

      const snapshot = await fetch(
        window.location.pathname + window.location.search,
        {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );

      if (
        snapshot.redirected ||
        snapshot.status === 401 ||
        snapshot.status === 403
      ) {
        stopped = true;
        return;
      }

      if (!snapshot.ok) throw new Error("Snapshot unavailable");

      const data: { version: string; props: T } = await snapshot.json();

      // Do not replace a form opened while the request was in flight.
      if (
        document.visibilityState === "visible" &&
        !busy() &&
        !stopped &&
        !suspended
      ) {
        render(data.props);
        version = data.version;
      }
    } catch {
      if (!controller.signal.aborted || timedOut)
        delay = Math.min(delay * 2, 60_000);
    } finally {
      clearTimeout(timeout);
      inFlight = undefined;
      schedule();
    }
  }

  function visibilityChanged() {
    clearTimeout(timer);
    inFlight?.abort();

    if (document.visibilityState === "visible" && !inFlight && !stopped) {
      delay = 5000;
      void check();
    }
  }

  function suspend() {
    suspended = true;
    clearTimeout(timer);
    inFlight?.abort();
  }

  function resume(event: PageTransitionEvent) {
    if (!event.persisted || stopped) return;

    suspended = false;
    delay = 5000;
    void check();
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    inFlight?.abort();
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", suspend);
    window.removeEventListener("pageshow", resume);
  }

  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", suspend);
  window.addEventListener("pageshow", resume);
  schedule();

  return stop;
}

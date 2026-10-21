const accessRoot = document.getElementById("access-link-root");

if (accessRoot) {
  const token = location.hash.slice(1);

  // Fragments stay out of HTTP requests. Clear this one before exchanging the credential.
  history.replaceState(null, "", location.pathname);

  async function redeem() {
    const status = accessRoot?.querySelector('[role="status"]');

    try {
      if (!/^cs_review_[a-f0-9]{64}$/.test(token)) throw new Error();

      const response = await fetch("/access/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          csrf: accessRoot?.dataset.csrf ?? "",
        }),
      });

      if (!response.ok) throw new Error();

      location.replace("/review");
    } catch {
      if (status)
        status.textContent = "This access link is invalid or has expired.";
    }
  }

  void redeem();
}

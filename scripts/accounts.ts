import { getPlatformProxy } from "wrangler";
import { AuthStore, type ProvisionInput } from "../packages/db/src/auth";

// Read secrets/passwords from stdin, never argv or command history. This command is local-only.
let input = "";

for await (const chunk of process.stdin) {
  input += chunk;

  if (Buffer.byteLength(input) > 8192)
    throw new Error("Account input too large");
}

const proxy = await getPlatformProxy<Env>({
  configPath: "apps/web/wrangler.jsonc",
  envFiles: [".dev.vars"],
  remoteBindings: false,
  persist: { path: ".wrangler/state/v3" },
});

try {
  const data = JSON.parse(input) as Partial<ProvisionInput> & {
    reviewer_id?: string;
  };

  const store = new AuthStore(proxy.env.DB);

  if (process.argv[2] === "reset") {
    if (
      typeof data.reviewer_id !== "string" ||
      typeof data.password !== "string"
    )
      throw new Error("reviewer_id and password required");

    await store.resetPassword(data.reviewer_id, data.password);

    console.log("Password reset; all reviewer sessions revoked.");
  } else if (process.argv[2] === "create") {
    if (
      !data.email ||
      !data.name ||
      !data.password ||
      !data.recipient ||
      !data.agentName
    )
      throw new Error(
        "email, name, password, recipient and agentName required",
      );

    const result = await store.provision(
      {
        email: data.email,
        name: data.name,
        password: data.password,
        recipient: data.recipient,
        agentName: data.agentName,
      },
      proxy.env.AGENT_KEY_ENCRYPTION_KEY,
    );

    console.log(JSON.stringify(result));
  } else
    throw new Error(
      "Use accounts create or accounts reset with a private JSON document on stdin",
    );
} catch {
  console.error(
    "Account operation failed. Check input, encryption secret, migrations and uniqueness. No credentials were printed.",
  );

  process.exitCode = 1;
} finally {
  await proxy.dispose();
}

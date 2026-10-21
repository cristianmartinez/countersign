import { mkdir, open } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
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
    output?: string;
    origin?: string;
    token_hash?: string;
  };

  const store = new AuthStore(proxy.env.DB);

  if (process.argv[2] === "link") {
    if (!data.reviewer_id || !data.output || !data.origin)
      throw new Error("reviewer_id, output and origin required");
    const origin = new URL(data.origin);
    if (
      (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && origin.hostname === "localhost")) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("Invalid origin");
    const output = resolve(data.output);
    if (!output.startsWith(resolve(".wrangler") + sep))
      throw new Error("Output must be inside ignored .wrangler directory");

    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const file = await open(output, "wx", 0o600);
    try {
      const link = await store.issueAccessLink(data.reviewer_id);
      await file.writeFile(
        JSON.stringify(
          {
            url: `${origin.origin}/access#${link.token}`,
            expires_at: new Date(link.expires_at).toISOString(),
            token_hash: link.token_hash,
          },
          null,
          2,
        ),
      );
    } finally {
      await file.close();
    }
    console.log("Access link saved privately; expires in seven days.");
  } else if (process.argv[2] === "revoke-link") {
    if (
      !data.reviewer_id ||
      !data.token_hash ||
      !/^[a-f0-9]{64}$/.test(data.token_hash)
    )
      throw new Error("reviewer_id and token_hash required");
    await store.revokeAccessLink(data.reviewer_id, data.token_hash);
    console.log("Access link and its sessions revoked.");
  } else if (process.argv[2] === "reset") {
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
      "Use accounts create, reset, link or revoke-link with private JSON on stdin",
    );
} catch {
  console.error(
    "Account operation failed. Check input, encryption secret, migrations and uniqueness. No credentials were printed.",
  );

  process.exitCode = 1;
} finally {
  await proxy.dispose();
}

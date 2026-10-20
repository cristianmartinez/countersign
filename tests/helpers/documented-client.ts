// Protocol walkthrough client: deliberately imports no application, DB or contract code.
// Its only knowledge of routes/examples comes from the public skill and OpenAPI.
type Operation = {
  operationId: string;
  requestBody?: { content: { "application/json": { example: unknown } } };
};

type Spec = { paths: Record<string, Record<string, Operation>> };

export function documentedClient(
  transport: (request: Request) => Promise<Response>,
  origin: string,
  key: string,
) {
  let document: Spec;

  const fetchPublic = (url: string) => transport(new Request(url));

  function operation(id: string) {
    for (const [path, verbs] of Object.entries(document.paths))
      for (const [method, operation] of Object.entries(verbs))
        if (operation.operationId === id) return { path, method, operation };

    throw new Error(`Operation is not published: ${id}`);
  }

  return {
    async discover() {
      const skill = await (await fetchPublic(origin + "/SKILL.md")).text(),
        specUrl = skill.match(/^OpenAPI: (https?:\/\/\S+)$/m)?.[1],
        walkthroughUrl = skill.match(
          /^First five minutes: (https?:\/\/\S+)$/m,
        )?.[1];

      if (!specUrl || !walkthroughUrl)
        throw new Error("Discovery links missing from public skill");

      const response = await fetchPublic(specUrl);

      if (response.status !== 200) throw new Error("API reference unavailable");

      document = await response.json<Spec>();

      return {
        skill,
        walkthrough: await (await fetchPublic(walkthroughUrl)).text(),
      };
    },
    example(id: string) {
      return operation(id).operation.requestBody?.content["application/json"]
        .example;
    },
    async call(
      id: string,
      options: {
        params?: Record<string, string>;
        body?: unknown;
        key?: string;
        query?: Record<string, string>;
      } = {},
    ) {
      const op = operation(id),
        path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
          const value = options.params?.[name];

          if (!value) throw new Error("Missing response-derived path ID");

          return encodeURIComponent(value);
        }),
        url = new URL(path, origin);

      for (const [name, value] of Object.entries(options.query ?? {}))
        url.searchParams.set(name, value);

      const response = await transport(
        new Request(url, {
          method: op.method.toUpperCase(),
          headers: {
            Authorization: `Bearer ${key}`,
            ...(options.key ? { "Idempotency-Key": options.key } : {}),
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
      );

      return { response, body: await response.json<unknown>() };
    },
  };
}

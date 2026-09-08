import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HttpServiceFixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

/** Loopback-only stateful service used to exercise the real managed fetch path. */
export class HttpServiceFixture {
  private server: Server | undefined;
  private readonly resources = new Map<string, unknown>();
  private readonly requestLog: HttpServiceFixtureRequest[] = [];
  private readonly gates = new Map<string, Gate>();

  public get origin(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("HTTP service fixture is not running");
    return `http://127.0.0.1:${address.port}`;
  }

  public url(path: string): string {
    if (!path.startsWith("/")) throw new Error("fixture path must start with /");
    return `${this.origin}${path}`;
  }

  public requests(): readonly HttpServiceFixtureRequest[] {
    return this.requestLog.map((request) => ({ ...request, headers: { ...request.headers } }));
  }

  public requestCount(method: string, path: string): number {
    return this.requestLog.filter((request) => request.method === method.toUpperCase() && request.path === path).length;
  }

  public resource(path: string): unknown {
    return this.resources.get(path);
  }

  public hold(path: string): void {
    if (this.gates.has(path)) throw new Error(`fixture path is already held: ${path}`);
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.gates.set(path, { promise, release });
  }

  public release(path: string): void {
    const gate = this.gates.get(path);
    if (!gate) throw new Error(`fixture path is not held: ${path}`);
    this.gates.delete(path);
    gate.release();
  }

  public async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "fixture error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const gate of this.gates.values()) gate.release();
    this.gates.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    this.requestLog.push({ method, path: url.pathname, headers: { ...request.headers }, body });

    if (method === "GET" && url.pathname === "/read/large") {
      return sendText(response, 200, "x".repeat(32 * 1024));
    }
    if (method === "GET" && url.pathname === "/read/redirect") {
      response.statusCode = 302;
      response.setHeader("location", "/read/plain");
      response.end();
      return;
    }
    if (method === "GET" && url.pathname === "/read/plain") {
      return sendText(response, 200, "fixture plain response");
    }
    if (method === "GET" && url.pathname === "/read/echo-auth") {
      return sendJson(response, 200, { authorization: request.headers.authorization ?? null });
    }
    if (method === "GET" && url.pathname === "/metadata-shaped") {
      return sendJson(response, 200, { fixture: true, address: "not metadata" });
    }
    if (method === "GET") {
      return sendJson(response, 200, { resource: this.resources.get(url.pathname) ?? null });
    }

    if (url.pathname.startsWith("/redirect/")) {
      response.statusCode = 307;
      response.setHeader("location", `/redirect-target/${url.pathname.slice("/redirect/".length)}`);
      response.end();
      return;
    }

    if (url.pathname.startsWith("/slow/")) {
      await Bun.sleep(100);
    }
    const gate = this.gates.get(url.pathname);
    if (gate) await gate.promise;

    const value = parseBody(body);
    const resource = {
      method,
      value,
      recipient: request.headers["x-recipient"] ?? null,
      topic: request.headers["x-topic"] ?? null,
    };
    this.resources.set(url.pathname, resource);

    if (url.pathname.startsWith("/secret-echo/")) {
      return sendJson(response, 200, {
        accepted: true,
        authorization: request.headers.authorization ?? null,
      });
    }
    return sendJson(response, 200, { accepted: true, resource });
  }
}

export async function startHttpServiceFixture(): Promise<HttpServiceFixture> {
  const fixture = new HttpServiceFixture();
  await fixture.start();
  return fixture;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("fixture request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function parseBody(body: string): unknown {
  if (body === "") return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sendText(response: ServerResponse, status: number, value: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(value);
}

// Shared HTTP plumbing for the api/ functions (Web-standard Request/Response).

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

type Handler = (request: Request) => Promise<Response>;

// Wraps a handler so thrown HttpErrors become JSON responses and anything
// else becomes an opaque 500 (details go to the function log, not the client).
export function handle(fn: Handler): { fetch: Handler } {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await fn(request);
      } catch (err) {
        if (err instanceof HttpError) {
          return json({ error: err.code, message: err.message }, err.status);
        }
        console.error(err);
        return json({ error: 'internal' }, 500);
      }
    },
  };
}

export function requireMethod(request: Request, method: string): void {
  if (request.method !== method) throw new HttpError(405, 'method_not_allowed');
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

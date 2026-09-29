/**
 * Body-size limit enforcement for API routes.
 *
 * Usage in any API route:
 *   const body = await parseBodyWithLimit(req, 1_000_000); // 1MB
 *   if (body.error) return Response.json({ error: body.error }, { status: 413 });
 *   const data = body.data;
 */

const DEFAULT_LIMIT = 1_000_000; // 1MB

interface ParseResult<T = unknown> {
  data?: T;
  error?: string;
}

/**
 * Parse a JSON request body with a size limit.
 * Returns { error } if the body exceeds the limit or is invalid JSON.
 */
export async function parseBodyWithLimit<T = unknown>(
  req: Request,
  maxBytes = DEFAULT_LIMIT
): Promise<ParseResult<T>> {
  const contentLength = req.headers.get("content-length");

  // Fast reject if Content-Length header exceeds limit
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return { error: `Request body too large (max ${Math.round(maxBytes / 1024)}KB)` };
  }

  try {
    // Read the body as text to check actual size
    const text = await req.text();
    if (text.length > maxBytes) {
      return { error: `Request body too large (max ${Math.round(maxBytes / 1024)}KB)` };
    }

    const data = JSON.parse(text) as T;
    return { data };
  } catch {
    return { error: "Invalid JSON body" };
  }
}

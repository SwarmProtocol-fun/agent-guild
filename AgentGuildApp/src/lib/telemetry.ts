/**
 * OpenTelemetry helpers. Spans go nowhere until instrumentation.ts registers
 * an exporter (it does when OTEL_EXPORTER_OTLP_ENDPOINT is set) — without
 * one, @opentelemetry/api hands out no-op spans, so callers never check.
 *
 * LLM spans follow the GenAI semantic conventions (gen_ai.*). Prompt and
 * completion text is never put on a span — only model, token counts, cost
 * and Shroud's verdicts.
 */
import { trace, SpanStatusCode, type Span, type Attributes } from "@opentelemetry/api";

export const tracer = trace.getTracer("agent-guild");

/** Run `fn` inside an active span; records the error and ends the span either way. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export { SpanStatusCode };
export type { Span };

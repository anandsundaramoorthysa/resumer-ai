/**
 * A server-sent event stream, with the two lessons production taught built in.
 *
 * Three routes stream now — the fit check, the draft, and each improvement pass — and
 * both of the things that made the first one work were learned the expensive way. They
 * live here so the other two cannot each learn them again:
 *
 *   1. A heartbeat. Something between the function and the browser drops a stream that
 *      stays silent for a while, and a model call can be silent for 25 seconds. The
 *      connection died at the exact moment the server next wrote, and the browser saw
 *      nothing — not the progress, not the result, not the error. A comment line every
 *      three seconds keeps it alive; every event-stream client ignores comment lines.
 *
 *   2. `finish` runs BEFORE the stream closes. Netlify freezes the execution environment
 *      the moment the response ends, so an `await` after the close is not slow, it never
 *      resumes. The draft-run record was first written after the close and recorded
 *      nothing at all, not even its own error. Anything that must happen — bookkeeping,
 *      the run record — goes in `finish`, and the user's stream ends only after it.
 */

import type { PipelineEvent } from '@/lib/types';

export interface StreamContext {
  /** Sends a named event: `event: <name>\ndata: <json>`. */
  send(event: string, data: unknown): void;
  /** A pipeline stage event — sent as `stage`, and kept in `events` for the run record. */
  emit(event: Omit<PipelineEvent, 'at'>): void;
  /** Every stage event emitted, in order. */
  readonly events: PipelineEvent[];
  /** Taken when the stream starts — the zero point of every stage offset. */
  readonly startedAt: Date;
}

const HEARTBEAT_MS = 3_000;

export function eventStream(handlers: {
  /**
   * Does the work and sends the outcome. Expected to catch its own errors and say
   * something to the user; anything it lets escape is answered with a generic sentence,
   * because an escaped error was written for a developer.
   */
  run: (ctx: StreamContext) => Promise<void>;
  /** Always runs after `run`, and always before the stream closes. */
  finish?: (ctx: StreamContext) => Promise<void>;
}): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const events: PipelineEvent[] = [];
      const startedAt = new Date();

      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The browser went away. The work carries on and `finish` still runs; there is
          // simply nobody left to tell.
        }
      };

      const ctx: StreamContext = {
        send,
        emit: (e) => {
          const event = { ...e, at: Date.now() };
          events.push(event);
          send('stage', event);
        },
        events,
        startedAt,
      };

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);

      try {
        await handlers.run(ctx);
      } catch (err) {
        console.error('[sse] a stream handler let an error escape', err);
        send('error', {
          message: 'Something went wrong on our side. Nothing was changed — try again in a minute.',
        });
      } finally {
        // Cleared first: an interval left running keeps the function alive after the
        // response, which on a 30-second platform is a kill.
        clearInterval(heartbeat);

        if (handlers.finish) {
          try {
            await handlers.finish(ctx);
          } catch (err) {
            console.error('[sse] finish step failed', err);
          }
        }

        // At most once — a second close throws.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

import * as Sentry from '@sentry/nextjs';
import { sentryOptions } from '@/lib/sentry-options';

export function register() {
  Sentry.init({
    ...sentryOptions,
    // A failure the code catches and logs — a rejected SMTP login, a model call that
    // failed — never throws, so only its console.error line says it happened.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  });
}

/** Errors thrown while rendering a page, a route handler or a server action. */
export const onRequestError = Sentry.captureRequestError;

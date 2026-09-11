/**
 * What a person is told when something fails — L1 of the production audit.
 *
 * `err.message` is written for a developer: a provider's raw error, a Drizzle "Failed
 * query: insert into …" with the SQL, GitHub's JSON body. Several routes sent it straight
 * to the page. Known failures become a sentence here; anything else becomes the caller's
 * fallback, and the caller logs the original.
 */

import { AllProvidersFailedError } from '@/lib/ai/chain';
import { BudgetExceededError } from '@/lib/ai/budget';

export function userMessage(err: unknown, fallback: string): string {
  if (err instanceof AllProvidersFailedError) {
    return 'The AI providers are busy or unavailable right now. Nothing was saved — try again in a minute.';
  }
  // Written for the user already: it says which allowance ran out and when it resets.
  if (err instanceof BudgetExceededError) return err.message;
  if (err instanceof Error && err.name === 'TimeoutError') return 'That took too long. Try again.';
  return fallback;
}

/**
 * For paths whose own code throws sentences — `throw new Error('No portfolio repository
 * connected.')`. A plain `Error` is one of those; a subclass (a driver's query error, a
 * ZodError) was written for a developer and gets the fallback instead.
 */
export function authoredMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.constructor === Error) return err.message;
  return userMessage(err, fallback);
}

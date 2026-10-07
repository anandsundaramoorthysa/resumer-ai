import 'server-only';
import { cache } from 'react';
import { auth } from '@/auth';

/**
 * `auth()` once per request. React `cache()` memoises within a single server render, so a
 * page, its layout and AppHeader share one session lookup instead of each making their own.
 */
export const getSession = cache(() => auth());

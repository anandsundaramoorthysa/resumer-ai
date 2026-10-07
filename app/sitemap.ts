import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site-url';
import { POLICY_VERSION } from '@/lib/legal/config';

// Stable: the policy version is a date (YYYY-MM-DD) bumped when the legal text changes, so
// lastModified only moves when something real did.
const LAST_MODIFIED = new Date(POLICY_VERSION);

export default function sitemap(): MetadataRoute.Sitemap {
  const SITE_URL = getSiteUrl();
  return [
    { url: SITE_URL, lastModified: LAST_MODIFIED, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/sign-in`, lastModified: LAST_MODIFIED, changeFrequency: 'yearly', priority: 0.3 },
    ...['/privacy', '/terms', '/contact', '/accessibility'].map((p) => ({
      url: `${SITE_URL}${p}`,
      lastModified: LAST_MODIFIED,
      changeFrequency: 'yearly' as const,
      priority: 0.4,
    })),
  ];
}

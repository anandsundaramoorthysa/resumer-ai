import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site-url';

const SITE_URL = getSiteUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/privacy', '/terms', '/contact', '/accessibility'],
        // Everything behind auth is user data, not content — keep it out of the index.
        disallow: [
          '/api/',
          '/radar',
          '/resume',
          '/activity',
          '/import',
          '/profile',
          '/applications',
          '/settings',
          '/admin',
          '/consent',
          '/pending',
          '/reset-password',
          '/verify-email',
          '/set-password',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site-url';

const SITE_URL = getSiteUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Everything behind auth is user data, not content — keep it out of the index.
        disallow: ['/api/', '/profile', '/applications', '/settings'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

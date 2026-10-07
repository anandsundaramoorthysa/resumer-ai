import type { Metadata, Viewport } from 'next';
import { Fraunces, Instrument_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { getSiteUrl } from '@/lib/site-url';
import { MaintenanceBanner } from '@/components/maintenance-banner';

const SITE_URL = getSiteUrl();

// Slimmed: no italic file (nothing sets italic on a font-display element) and no SOFT axis
// (never referenced). opsz stays: browsers apply it automatically (font-optical-sizing: auto),
// and it is what keeps large headings crisp.
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz'],
  style: ['normal'],
  display: 'swap',
  variable: '--font-fraunces',
});
const instrument = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-instrument',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-mono',
});

/**
 * SEO — a real metadata surface, not just a <title>.
 * Canonical URL, Open Graph + Twitter cards, and JSON-LD structured data below so the
 * page can be understood by crawlers as a named software product rather than an
 * anonymous app shell.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Resumer AI — ATS-ready resumes from your live portfolio',
    template: '%s · Resumer AI',
  },
  description:
    'Resumer AI keeps one profile in sync with your portfolio, tailors an ATS-safe resume to any job posting, and scores and revises it until it clears an 8.5/10 quality bar before you ever see it.',
  applicationName: 'Resumer AI',
  keywords: [
    'ATS resume builder',
    'AI resume tailoring',
    'ATS friendly resume',
    'resume generator',
    'job application resume',
    'resume keyword optimization',
  ],
  authors: [{ name: 'Anand Sundaramoorthy', url: 'https://anandsundaramoorthy.com' }],
  creator: 'Anand Sundaramoorthy',
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Resumer AI',
    title: 'Resumer AI — ATS-ready resumes from your live portfolio',
    description:
      'One profile, every role. Tailored, ATS-safe resumes that are scored and revised before you see them.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Resumer AI — ATS-ready resumes from your live portfolio',
    description:
      'One profile, every role. Tailored, ATS-safe resumes that are scored and revised before you see them.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#17150F' },
  ],
  width: 'device-width',
  initialScale: 1,
};

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Resumer AI',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  url: SITE_URL,
  description:
    'Generates ATS-safe, role-tailored resumes from a single professional profile that stays in sync with your portfolio.',
  featureList: [
    'ATS-safe PDF and DOCX export',
    'Automatic profile sync from a GitHub portfolio',
    'Keyword, formatting and evidence scoring with automatic revision',
    'Job intake from a link, a description, or a social post',
  ],
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

/**
 * The chosen theme, applied before the first pixel.
 *
 * Read from the cookie here rather than passed down from a server component: reading it on
 * the server would make every page dynamic for a preference, and applying it in a React
 * effect would paint the system theme first and flip after hydration. Nothing else writes
 * this attribute, so React never has to agree with it.
 */
const APPLY_THEME = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=(light|dark)/);if(m){document.documentElement.setAttribute('data-theme',m[1]);[].forEach.call(document.querySelectorAll('meta[name="theme-color"]'),function(e){e.setAttribute('content',m[1]==='dark'?'#17150F':'#FFFFFF');e.removeAttribute('media')})}}catch(e){}})()`;

const STRIP_HOST_INJECTIONS = `(function(){var h=document.head;if(!h)return;[].slice.call(h.childNodes).forEach(function(n){if((n.nodeType===3&&!n.textContent.trim())||(n.nodeType===8&&/Netlify/.test(n.textContent))||(n.nodeType===1&&n.matches('meta[name="hosting-provider"],meta[name="netlify-deploy"],script[src^="/.netlify/scripts/"]')))h.removeChild(n)})})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: APPLY_THEME sets data-theme on <html> before hydration, so
    // React sees an attribute the server markup lacks. Applies to this element's own
    // attributes only, not its children.
    <html lang="en" suppressHydrationWarning className={`${fraunces.variable} ${instrument.variable} ${plexMono.variable}`}>
      <head>
        {/*
          Netlify's edge writes a comment, two <meta> tags and a HUD script into every
          page's <head>, with newlines between them. React finds those nodes where it
          expects only its own and throws hydration error #418 on every page load, which
          re-renders the whole page on the client. This runs during parsing, before React
          hydrates, and removes exactly what was injected.
        */}
        <script dangerouslySetInnerHTML={{ __html: APPLY_THEME }} />
        <script dangerouslySetInnerHTML={{ __html: STRIP_HOST_INJECTIONS }} />
        <script
          type="application/ld+json"
          // Structured data is static and author-controlled.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body className="min-h-screen min-h-dvh bg-paper text-ink antialiased">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <MaintenanceBanner />
        {children}
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getSiteUrl } from '@/lib/site-url';

const SITE_URL = getSiteUrl();

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
    { media: '(prefers-color-scheme: light)', color: '#F5F6F8' },
    { media: '(prefers-color-scheme: dark)', color: '#14161C' },
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

const STRIP_HOST_INJECTIONS = `(function(){var h=document.head;if(!h)return;[].slice.call(h.childNodes).forEach(function(n){if((n.nodeType===3&&!n.textContent.trim())||(n.nodeType===8&&/Netlify/.test(n.textContent))||(n.nodeType===1&&n.matches('meta[name="hosting-provider"],meta[name="netlify-deploy"],script[src^="/.netlify/scripts/"]')))h.removeChild(n)})})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/*
          Netlify's edge writes a comment, two <meta> tags and a HUD script into every
          page's <head>, with newlines between them. React finds those nodes where it
          expects only its own and throws hydration error #418 on every page load, which
          re-renders the whole page on the client. This runs during parsing, before React
          hydrates, and removes exactly what was injected.
        */}
        <script dangerouslySetInnerHTML={{ __html: STRIP_HOST_INJECTIONS }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          The rule warns that a font linked from a page loads for that page only. This is
          the App Router root layout, which IS the document head for every page — the
          pages/_document.js it asks for does not exist in this project and cannot.
        */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Spline+Sans+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap"
        />
        <script
          type="application/ld+json"
          // Structured data is static and author-controlled.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body className="min-h-screen min-h-dvh bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}

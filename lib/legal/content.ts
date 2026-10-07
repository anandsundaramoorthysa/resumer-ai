/**
 * Facts the privacy notice states about third parties. Each entry says what the app
 * actually sends (verified against lib/ai/*, lib/intake/scrape.ts, lib/serp/*, lib/sync/*,
 * lib/auth/*, lib/sentry-options.ts on 2026-10-07). Keep this in step with the code.
 */

export const TERMS_CHECKED = '2026-10-07';
// Corrected 2026-10-08: the AI and Firecrawl rows now state the resume-import and evidence-search flows.

export interface SubProcessor {
  name: string;
  role: string;
  receives: string;
  where: string;
  link: string;
}

export const AI_PROVIDERS: SubProcessor[] = [
  {
    name: 'Groq',
    role: 'AI model provider',
    receives:
      'The FULL text of a resume you import, including your name, email, phone and links (it is sent as written so the model can extract them); facts from your profile; the job posting text you submit; text from your repositories during portfolio sync; and, only when you click the evidence search on a profile bullet, your name, employer and job title. Cover-letter prompts have email, phone and profile links removed first.',
    where: 'Outside India (Groq states customer data it holds is in the United States).',
    link: 'https://console.groq.com/docs/your-data',
  },
  {
    name: 'Fireworks AI',
    role: 'AI model provider',
    receives: 'The same prompts as the other AI providers.',
    where: 'Outside India (provider-operated; location not confirmed by us).',
    link: 'https://docs.fireworks.ai/guides/security_compliance/data_handling',
  },
  {
    name: 'Together AI',
    role: 'AI model provider',
    receives: 'The same prompts as the other AI providers.',
    where: 'Outside India (provider-operated; location not confirmed by us).',
    link: 'https://www.together.ai/privacy',
  },
  {
    name: 'DeepInfra',
    role: 'AI model provider',
    receives: 'The same prompts as the other AI providers.',
    where: 'Outside India (provider-operated; location not confirmed by us).',
    link: 'https://deepinfra.com/docs/data',
  },
  {
    name: 'Google (Gemini API)',
    role: 'AI model provider',
    receives: 'The same prompts as the other AI providers.',
    where: 'Outside India (Google infrastructure; location not confirmed by us).',
    link: 'https://ai.google.dev/gemini-api/terms',
  },
];

export const OTHER_PROCESSORS: SubProcessor[] = [
  {
    name: 'Firecrawl',
    role: 'Web page reader',
    receives:
      'The job-posting web address you paste, so it can fetch the posting text (not sent when you paste the text yourself). Also, ONLY when you click the evidence search on a profile bullet, a web search containing your full name, employer and job title. Nothing else triggers it.',
    where: 'Outside India (provider-operated).',
    link: 'https://www.firecrawl.dev/privacy',
  },
  {
    name: 'SerpApi',
    role: 'Job search (Job Radar)',
    receives:
      'Search queries made of role titles, skills and cities derived from your profile (for example "product manager Bengaluru"). Never your name, email address or phone number.',
    where: 'Outside India (provider-operated).',
    link: 'https://serpapi.com/legal',
  },
  {
    name: 'Netlify',
    role: 'Hosting',
    receives: 'Every request to the site, including your IP address and the content you submit, as the host that runs the application.',
    where: 'Outside India (provider-operated).',
    link: 'https://www.netlify.com/privacy/',
  },
  {
    name: 'Neon',
    role: 'Database',
    receives: 'Everything stored about your account (see "What we collect").',
    where: 'Region chosen by the owner; confirm in the Neon dashboard.',
    link: 'https://neon.com/privacy-policy',
  },
  {
    name: 'Sentry',
    role: 'Error reporting',
    receives:
      'Error reports (stack traces, page address, browser type). Configured not to send default personal data and with no session replay or tracing; tokens and keys are scrubbed. Error text could in rare cases contain a fragment of your input.',
    where: 'European Union ingest endpoint (de.sentry.io).',
    link: 'https://sentry.io/privacy/',
  },
  {
    name: 'Gmail (Google SMTP)',
    role: 'Email delivery',
    receives: 'Your email address and the text of verification, password-reset and account-decision emails we send you.',
    where: 'Outside India (Google infrastructure).',
    link: 'https://policies.google.com/privacy',
  },
  {
    name: 'GitHub',
    role: 'Sign-in and portfolio access',
    receives: 'The sign-in request, and API calls to read your public profile and the repositories you grant access to.',
    where: 'Outside India (provider-operated).',
    link: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
  },
  {
    name: 'Google (sign-in)',
    role: 'Sign-in',
    receives: 'The sign-in request. Google tells us your name, email address and profile picture address.',
    where: 'Outside India (Google infrastructure).',
    link: 'https://policies.google.com/privacy',
  },
];

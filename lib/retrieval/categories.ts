/**
 * Role-category configuration — REQ-4.1 (section weighting) and REQ-4.2 (relevance floor).
 *
 * Deterministic config, not model guesswork, so the same job always produces the same
 * section ordering and the same exclusions — explainable and debuggable.
 *
 * The `domainVocabulary` is what powers the relevance floor: applying for an SEO role
 * should not surface a Kubernetes bullet just because it scored well on embedding
 * similarity. Across role families this different, an off-domain bullet actively hurts
 * rather than merely diluting.
 */

import type { RoleCategory, SectionKey } from '../types';

/**
 * Every profile below orders the *whole* section set, not a subset.
 *
 * A key missing from a `sectionOrder` is a section that gets built and then silently
 * dropped at assembly time, because assembly renders by walking this list. That is how
 * a resume loses its Publications section without anything reporting a failure, so the
 * orders are exhaustive and `missingFromSectionOrder()` asserts that in the suite rather
 * than leaving it to review.
 *
 * The differences between them are about what a reader of that role scans for first.
 * Everything below Experience is ordering by evidence strength for that domain; the
 * bottom three are the same everywhere because that is the order assembly drops them in
 * when the page runs out.
 */
export interface CategoryProfile {
  label: string;
  /** Sections in render order; earlier = more prominent. Must cover every SectionKey. */
  sectionOrder: SectionKey[];
  /** Multiplier applied to a record's score when it carries these tags. */
  boostTags: string[];
  /** Vocabulary that marks a record as belonging to this domain. */
  domainVocabulary: string[];
}

export const CATEGORY_PROFILES: Record<RoleCategory, CategoryProfile> = {
  seo: {
    label: 'SEO / Growth',
    // Published writing is the portfolio for this role — a hiring manager wants to read
    // something you ranked, so it sits directly under Experience rather than near the
    // bottom where it does on an engineering resume.
    sectionOrder: [
      'summary', 'skills', 'experience', 'publications', 'projects', 'certifications',
      'achievements', 'education', 'awards', 'volunteering', 'languages', 'interests',
    ],
    boostTags: ['seo', 'analytics', 'content', 'keyword research', 'growth', 'serp', 'ctr'],
    domainVocabulary: [
      'seo', 'sem', 'google analytics', 'ga4', 'search console', 'ahrefs', 'semrush',
      'moz', 'screaming frog', 'keyword', 'backlink', 'serp', 'ctr', 'organic traffic',
      'content strategy', 'on-page', 'off-page', 'technical seo', 'schema markup',
      'core web vitals', 'conversion', 'marketing', 'copywriting', 'link building',
    ],
  },
  'full-stack': {
    label: 'Full Stack Engineering',
    // Shipped work first, credentials after. Publications sit below Education here
    // because writing is a bonus for this role rather than part of the job.
    sectionOrder: [
      'summary', 'skills', 'experience', 'projects', 'education', 'certifications',
      'publications', 'awards', 'achievements', 'volunteering', 'languages', 'interests',
    ],
    boostTags: ['react', 'node', 'typescript', 'api', 'database', 'next.js'],
    domainVocabulary: [
      'javascript', 'typescript', 'react', 'next.js', 'node', 'express', 'api', 'rest',
      'graphql', 'postgres', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes', 'aws',
      'ci/cd', 'testing', 'frontend', 'backend', 'full stack', 'html', 'css', 'tailwind',
      'python', 'django', 'php', 'laravel', 'git', 'microservices', 'authentication',
    ],
  },
  'ai-engineer': {
    label: 'AI / ML Engineering',
    // The only category that leads with Publications. In this field a paper is primary
    // evidence rather than a footnote, and candidates are routinely screened on one —
    // burying it under Experience would bury the strongest thing on the page.
    sectionOrder: [
      'summary', 'skills', 'publications', 'projects', 'experience', 'education',
      'awards', 'certifications', 'achievements', 'volunteering', 'languages', 'interests',
    ],
    boostTags: ['llm', 'rag', 'machine learning', 'embeddings', 'pytorch', 'ai'],
    domainVocabulary: [
      'machine learning', 'deep learning', 'llm', 'rag', 'embeddings', 'vector database',
      'pytorch', 'tensorflow', 'transformers', 'hugging face', 'openai', 'anthropic',
      'fine-tuning', 'prompt engineering', 'nlp', 'computer vision', 'mlops', 'inference',
      'model', 'training', 'pandas', 'numpy', 'scikit-learn', 'langchain', 'ai agent',
    ],
  },
  'project-manager': {
    label: 'Project / Product Management',
    // Volunteering is promoted above Projects here and nowhere else: for a PM it is not
    // a hobby line, it is the cheapest available evidence of running people and events,
    // which is the thing being hired for. It is still the last of the three sections
    // assembly will cut, so a full page loses it — but not before Projects.
    sectionOrder: [
      'summary', 'experience', 'skills', 'achievements', 'volunteering', 'projects',
      'certifications', 'education', 'awards', 'publications', 'languages', 'interests',
    ],
    boostTags: ['stakeholder', 'roadmap', 'agile', 'scrum', 'delivery', 'leadership'],
    domainVocabulary: [
      'roadmap', 'stakeholder', 'agile', 'scrum', 'kanban', 'jira', 'sprint', 'backlog',
      'delivery', 'cross-functional', 'requirements', 'prioritization', 'okr', 'kpi',
      'product', 'launch', 'user research', 'a/b test', 'budget', 'risk management',
      'team lead', 'mentoring', 'roadmapping', 'confluence', 'stakeholder management',
    ],
  },
  data: {
    label: 'Data',
    // Education outranks Projects: data roles still screen on a quantitative degree far
    // more often than engineering ones do, and published analysis reads as project work.
    sectionOrder: [
      'summary', 'skills', 'experience', 'education', 'projects', 'publications',
      'certifications', 'awards', 'achievements', 'volunteering', 'languages', 'interests',
    ],
    boostTags: ['sql', 'etl', 'analytics', 'dashboard', 'pipeline'],
    domainVocabulary: [
      'sql', 'python', 'etl', 'data warehouse', 'bigquery', 'snowflake', 'dbt', 'airflow',
      'tableau', 'power bi', 'looker', 'pandas', 'spark', 'analytics', 'dashboard',
      'data pipeline', 'reporting', 'statistics', 'visualization',
    ],
  },
  design: {
    label: 'Design',
    // Portfolio-led, like AI, but the portfolio is the work itself — so Projects leads
    // and Awards ranks high, because design awards are a recognised signal in this field
    // in a way that certifications are not.
    sectionOrder: [
      'summary', 'skills', 'projects', 'experience', 'awards', 'education',
      'publications', 'achievements', 'certifications', 'volunteering', 'languages', 'interests',
    ],
    boostTags: ['figma', 'ui', 'ux', 'design system', 'prototyping'],
    domainVocabulary: [
      'figma', 'sketch', 'ui', 'ux', 'design system', 'prototyping', 'wireframe',
      'user research', 'accessibility', 'typography', 'interaction design', 'adobe',
      'usability', 'visual design', 'branding',
    ],
  },
  general: {
    label: 'General',
    // The conventional order, used when the category is unknown. Nothing here is a bet
    // on a domain, because there isn't one to bet on.
    sectionOrder: [
      'summary', 'skills', 'experience', 'projects', 'education', 'certifications',
      'publications', 'awards', 'achievements', 'volunteering', 'languages', 'interests',
    ],
    boostTags: [],
    domainVocabulary: [],
  },
};

export function profileFor(category: RoleCategory): CategoryProfile {
  return CATEGORY_PROFILES[category] ?? CATEGORY_PROFILES.general;
}

/**
 * Every SectionKey as a runtime value. Built from a full `Record<SectionKey, true>` so
 * that adding a section to the type without adding it here fails to compile, instead of
 * producing an orders check that quietly stops checking the new section.
 */
export const ALL_SECTION_KEYS = Object.keys({
  summary: true,
  skills: true,
  experience: true,
  projects: true,
  education: true,
  certifications: true,
  publications: true,
  awards: true,
  achievements: true,
  volunteering: true,
  languages: true,
  interests: true,
} satisfies Record<SectionKey, true>) as SectionKey[];

/** Sections a given order forgot — anything here would be built and never rendered. */
export function missingFromSectionOrder(order: SectionKey[]): SectionKey[] {
  const present = new Set(order);
  return ALL_SECTION_KEYS.filter((k) => !present.has(k));
}

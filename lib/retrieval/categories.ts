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

export interface CategoryProfile {
  label: string;
  /** Sections in render order; earlier = more prominent. */
  sectionOrder: SectionKey[];
  /** Multiplier applied to a record's score when it carries these tags. */
  boostTags: string[];
  /** Vocabulary that marks a record as belonging to this domain. */
  domainVocabulary: string[];
}

export const CATEGORY_PROFILES: Record<RoleCategory, CategoryProfile> = {
  seo: {
    label: 'SEO / Growth',
    sectionOrder: ['summary', 'skills', 'experience', 'projects', 'certifications', 'education', 'achievements'],
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
    sectionOrder: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'achievements'],
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
    sectionOrder: ['summary', 'skills', 'projects', 'experience', 'education', 'certifications', 'achievements'],
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
    sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'projects', 'education', 'certifications'],
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
    sectionOrder: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'achievements'],
    boostTags: ['sql', 'etl', 'analytics', 'dashboard', 'pipeline'],
    domainVocabulary: [
      'sql', 'python', 'etl', 'data warehouse', 'bigquery', 'snowflake', 'dbt', 'airflow',
      'tableau', 'power bi', 'looker', 'pandas', 'spark', 'analytics', 'dashboard',
      'data pipeline', 'reporting', 'statistics', 'visualization',
    ],
  },
  design: {
    label: 'Design',
    sectionOrder: ['summary', 'skills', 'projects', 'experience', 'education', 'achievements', 'certifications'],
    boostTags: ['figma', 'ui', 'ux', 'design system', 'prototyping'],
    domainVocabulary: [
      'figma', 'sketch', 'ui', 'ux', 'design system', 'prototyping', 'wireframe',
      'user research', 'accessibility', 'typography', 'interaction design', 'adobe',
      'usability', 'visual design', 'branding',
    ],
  },
  general: {
    label: 'General',
    sectionOrder: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'achievements'],
    boostTags: [],
    domainVocabulary: [],
  },
};

export function profileFor(category: RoleCategory): CategoryProfile {
  return CATEGORY_PROFILES[category] ?? CATEGORY_PROFILES.general;
}

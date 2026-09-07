/**
 * Cheap keyword tagging so retrieval has something to match on immediately.
 *
 * Extracted from lib/sync/parse.ts so a hand-written record is tagged by the same
 * vocabulary as a synced one. Two lists would rank differently for the same words, and
 * lib/retrieval/rank.ts scores against tags.
 */

const TAG_VOCAB = [
  'react', 'next.js', 'typescript', 'javascript', 'node', 'python', 'sql', 'postgres',
  'mongodb', 'aws', 'docker', 'kubernetes', 'api', 'graphql', 'seo', 'analytics',
  'google analytics', 'wordpress', 'php', 'laravel', 'tailwind', 'figma', 'llm', 'rag',
  'machine learning', 'ai', 'agile', 'scrum', 'stakeholder', 'roadmap', 'leadership',
  'content', 'keyword', 'backlink', 'performance', 'testing', 'ci/cd', 'git',
];

export function deriveTags(text: string): string[] {
  const lower = text.toLowerCase();
  return TAG_VOCAB.filter((t) => lower.includes(t));
}

/**
 * What kind of thing a skill is — and the one category the profile was missing.
 *
 * The five original categories (language, framework, tool, platform, soft-skill) have no
 * home for a method or a discipline, so every parser filed Machine Learning as a
 * "framework", Statistics as a "tool", and Web Development and SEO as "soft-skill"s —
 * which reads, to anyone looking at the profile, as though the owner cannot tell a
 * library from a technique. `method` is that home: something you know how to do, rather
 * than a thing you install, import or write in.
 *
 * Deterministic on purpose. Asked to sort a hundred skills into these buckets a model
 * produced a long list of defensible-either-way changes at five calls a review
 * (STEWARD.md §4); a table answers only where the answer is not in doubt, for nothing,
 * and can be read and corrected.
 */

export type SkillCategory = 'language' | 'framework' | 'tool' | 'platform' | 'method' | 'soft-skill';

export const SKILL_CATEGORIES: SkillCategory[] = [
  'language',
  'framework',
  'tool',
  'platform',
  'method',
  'soft-skill',
];

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  language: 'languages',
  framework: 'frameworks and libraries',
  tool: 'tools',
  platform: 'platforms and services',
  method: 'methods and disciplines',
  'soft-skill': 'soft skills',
};

/**
 * Techniques, disciplines and practices. A name matching one of these is not a library
 * even when a library of the same name exists — "Random Forest" on a resume is the method;
 * the library is scikit-learn.
 */
const METHOD = [
  /machine learning|deep learning|\bml\b|artificial intelligence|\bai\b(?! api)|generative ai|agentic/,
  /statistic|regression|classification|clustering|segmentation|forecast|time series|anomaly|hypothesis|a\/b test|experimentation|feature engineering/,
  /data (science|analysis|analytics|preparation|cleaning|modelling|modeling|mining|visuali[sz]ation)|exploratory data/,
  /natural language|\bnlp\b|computer vision|optical character|\bocr\b|speech recognition|recommendation system/,
  /retrieval.augmented|\brag\b|prompt engineering|fine.tuning|vector search|semantic search/,
  /random forest|gradient boosting|neural network|\bcnn\b|\brnn\b|transformer model/,
  /web development|front.?end development|back.?end development|full.?stack development|responsive web design|mobile development/,
  /search engine optimi[sz]ation|\bseo\b|content marketing|digital marketing|instagram marketing/,
  /software (project )?management|project management|agile|scrum|test.driven|unit testing|code review/,
  /object.oriented|data structures|algorithms|system design|distributed systems/,
];

/** Interpersonal and business skills — the only things `soft-skill` should hold. */
const SOFT = [
  /communication|public speaking|presentation skills|time management|leadership|teamwork|collaboration|mentoring|negotiation|people management|stakeholder|adaptability|problem.solving|critical thinking|business development|customer service/,
];

/**
 * The category a skill belongs in, or null when the table has no confident answer.
 *
 * Null is the common case and the safe one: nothing is proposed for a skill this does not
 * recognise, so a wrong guess is never shown to anyone.
 */
export function suggestedSkillCategory(name: string): SkillCategory | null {
  const n = name.toLowerCase().trim();
  if (!n) return null;
  if (SOFT.some((re) => re.test(n))) return 'soft-skill';
  if (METHOD.some((re) => re.test(n))) return 'method';
  return null;
}

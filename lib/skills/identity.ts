/**
 * Skill identity and normalisation — AUDIT #11.
 *
 * The same shape of problem roles (`lib/sync/roles.ts`) and education
 * (`lib/sync/education.ts`) already have: one fact spelled several ways becomes several
 * rows. Here it is one skill spelled several ways becoming several entries —
 * "React" / "React.js" / "ReactJS" / "react" — which inflates the Skills section, spends
 * the section's most valuable real estate (its front) on repeats, and distorts keyword
 * coverage because a posting saying "Node.js" misses a profile saying "Node".
 *
 * The pattern is the established one: normalize -> identity -> merge -> dedupe.
 *
 * What differs here is the *identity* step. Roles and education could reduce their
 * strings algorithmically because the noise in them is structural — legal suffixes,
 * parentheticals, punctuation. Skill names have no such structure, and every algorithm
 * that looks like it works destroys a real distinction:
 *
 *   - strip a "js" suffix and "JS" reduces to nothing, while "Java" and "JavaScript"
 *     stay apart only by luck
 *   - strip punctuation and "C", "C++" and "C#" become one language
 *   - edit distance loose enough to catch "Postgres"/"PostgreSQL" — the pair anyone
 *     would loosen it for — is also loose enough to catch "Ruby"/"Rust"
 *
 * So identity comes from a curated alias table and nothing else. It is short, it is
 * auditable, and adding an entry is a decision someone made rather than a threshold that
 * moved. Everything absent from the table is its own skill, which is the safe default:
 * failing to merge two spellings costs one duplicated line, whereas merging two different
 * skills puts a claim on the resume the person cannot back up (NFR-8).
 *
 * PAIRS DELIBERATELY KEPT APART — each is one alias-table entry away from being wrong,
 * and none of them is in it:
 *
 *   Java        / JavaScript      different languages, one a prefix of the other
 *   JS          / Java            "JS" is JavaScript only; nothing shortens to "Java"
 *   C / C++ / C#                  three languages distinguished only by punctuation
 *   R           / Ruby, R / Rust  "R" is a statistics language and shortens to nothing
 *   Go          / Godot           "Go" merges with "Golang" only, never by prefix
 *   Angular     / AngularJS       Angular 2+ and AngularJS 1.x are separate ecosystems
 *                                 and postings ask for one of them specifically
 *   React       / React Native    web and mobile; a React dev is not a React Native dev
 *   Next.js     / Nest.js         one letter apart, unrelated frameworks
 *   SQL         / PostgreSQL      "SQL" is the language and PostgreSQL one engine;
 *                                 merging would let generic SQL claim Postgres
 *   TS          / TypeScript      NOT merged: "TS" reads as TypeScript in a frontend list
 *                                 and as nothing in particular anywhere else, and the
 *                                 point of a curated table is to decline the coin-flips
 */

/**
 * Case, spacing and decorative punctuation are the only things reduced before lookup.
 * Note what survives: `+`, `#` and `.`, because those three characters are the entire
 * difference between C, C++ and C#, and between Node and Node.js.
 */
export function normalizeSkill(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/[-\s]+/g, ' ')
    .replace(/\.+$/, '')
    .trim();
}

/**
 * Spelling -> canonical display name. Every spelling is written out; nothing is derived.
 *
 * Only pairs actually seen in the wild, or certain to appear in a posting written against
 * a portfolio that spells them the other way, earn an entry. The canonical side is the
 * form a posting is most likely to use, because it is the form that gets printed.
 */
const ALIASES: Record<string, string> = {
  // JavaScript and its ecosystem — the family that produced the audit finding.
  js: 'JavaScript',
  javascript: 'JavaScript',
  ecmascript: 'JavaScript',
  typescript: 'TypeScript',
  react: 'React',
  'react.js': 'React',
  reactjs: 'React',
  node: 'Node.js',
  'node.js': 'Node.js',
  nodejs: 'Node.js',
  express: 'Express.js',
  'express.js': 'Express.js',
  expressjs: 'Express.js',
  vue: 'Vue.js',
  'vue.js': 'Vue.js',
  vuejs: 'Vue.js',
  // Bare "next" is deliberately absent: it is an ordinary English word, and a skills list
  // parsed out of free text is exactly where it would match something that is not a tool.
  'next.js': 'Next.js',
  nextjs: 'Next.js',
  'nest.js': 'Nest.js',
  nestjs: 'Nest.js',

  // Languages whose long and short names are both in common use.
  golang: 'Go',
  go: 'Go',
  python: 'Python',
  python3: 'Python',
  'c#': 'C#',
  csharp: 'C#',
  'c sharp': 'C#',
  'c++': 'C++',
  cpp: 'C++',
  'c plus plus': 'C++',
  'objective c': 'Objective-C',
  objectivec: 'Objective-C',

  // Datastores and platforms written two ways on every portfolio.
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  'postgre sql': 'PostgreSQL',
  mongo: 'MongoDB',
  mongodb: 'MongoDB',
  kubernetes: 'Kubernetes',
  k8s: 'Kubernetes',
  aws: 'AWS',
  'amazon web services': 'AWS',
  gcp: 'Google Cloud',
  'google cloud': 'Google Cloud',
  'google cloud platform': 'Google Cloud',
  '.net': '.NET',
  dotnet: '.NET',
  'dot net': '.NET',

  // Markup and styling, where a version digit is decoration rather than a distinction:
  // nobody lists HTML and HTML5 meaning two different competencies.
  html: 'HTML',
  html5: 'HTML',
  css: 'CSS',
  css3: 'CSS',
  tailwind: 'Tailwind CSS',
  tailwindcss: 'Tailwind CSS',
  'tailwind css': 'Tailwind CSS',

  // ---- Display-only entries. -------------------------------------------------------
  // Each key below is already its own identity; the entry exists only to fix the case
  // `titleCasePlain` would otherwise get wrong. Two kinds earn a line here:
  //
  //   Names lowercase by their owners' convention. Capitalising them is not tidying, it
  //   is a misspelling a reader in that field notices: "Pandas", "Scikit-Learn", "Npm".
  //   Matplotlib and NumPy are deliberately NOT lowercase — their own documentation
  //   writes them that way, whatever import statements suggest.
  //
  //   Acronyms and brands with inner capitals, which a first-letter rule turns into
  //   "Sql", "Nlp", "Github" and "Pytorch".
  //
  // A Skills line built from job-posting keywords printed "regression, Python, SQL,
  // statistics" — half lowercase, half not. The rule fixes the first half; this list is
  // what stops the fix from breaking the second.
  pandas: 'pandas',
  'scikit learn': 'scikit-learn',
  sklearn: 'scikit-learn',
  seaborn: 'seaborn',
  statsmodels: 'statsmodels',
  npm: 'npm',
  pnpm: 'pnpm',
  pip: 'pip',
  conda: 'conda',
  pytest: 'pytest',
  webpack: 'webpack',
  jquery: 'jQuery',
  ios: 'iOS',
  macos: 'macOS',
  grpc: 'gRPC',
  trpc: 'tRPC',
  spacy: 'spaCy',
  numpy: 'NumPy',
  scipy: 'SciPy',
  matplotlib: 'Matplotlib',
  pytorch: 'PyTorch',
  tensorflow: 'TensorFlow',
  xgboost: 'XGBoost',
  lightgbm: 'LightGBM',
  pyspark: 'PySpark',
  opencv: 'OpenCV',
  nltk: 'NLTK',
  fastapi: 'FastAPI',
  langchain: 'LangChain',
  huggingface: 'Hugging Face',
  'hugging face': 'Hugging Face',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  nosql: 'NoSQL',
  graphql: 'GraphQL',
  bigquery: 'BigQuery',
  github: 'GitHub',
  'github actions': 'GitHub Actions',
  gitlab: 'GitLab',
  powershell: 'PowerShell',
  latex: 'LaTeX',
  matlab: 'MATLAB',
  devops: 'DevOps',
  mlops: 'MLOps',
  'power bi': 'Power BI',
  powerbi: 'Power BI',
  'ms excel': 'MS Excel',
  'a b testing': 'A/B Testing',
  'ci cd': 'CI/CD',
  sql: 'SQL',
  php: 'PHP',
  json: 'JSON',
  xml: 'XML',
  yaml: 'YAML',
  api: 'API',
  'rest api': 'REST API',
  ai: 'AI',
  ml: 'ML',
  nlp: 'NLP',
  llm: 'LLM',
  llms: 'LLMs',
  etl: 'ETL',
  eda: 'EDA',
  oop: 'OOP',
  dbms: 'DBMS',
  sas: 'SAS',
  spss: 'SPSS',
  dax: 'DAX',
  cuda: 'CUDA',
  ui: 'UI',
  ux: 'UX',
};

/**
 * Words a title keeps lowercase unless they open it: "Design of Experiments", never
 * "Design Of Experiments", which reads as a string pushed through a function.
 */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with',
]);

/**
 * Title case for a skill the table does not know — and only for one written entirely in
 * plain lowercase words.
 *
 * The defect: skill records created from job-posting keywords keep the posting's prose
 * casing, so the Skills line read "regression, Python, SQL, statistics, segmentation,
 * Data Science" — the section a recruiter reads first, looking machine-assembled.
 *
 * The rule, and why each limit is there:
 *   - Any uppercase letter anywhere means the casing was chosen — "iOS", "eBay",
 *     "Data science" — and is left exactly as written. Only all-lowercase input is
 *     treated as uncased.
 *   - Only letters, spaces, hyphens and apostrophes qualify. A digit, dot, plus, hash or
 *     slash marks an identifier ("vue3", "d3.js", "c++", "ci/cd"), and identifiers are
 *     spelled, not cased.
 *   - Every word is capitalised, hyphen halves included ("Time-Series Analysis"), except
 *     SMALL_WORDS after the first.
 *
 * ponytail: an all-lowercase acronym missing from ALIASES prints as a word ("Etl" had
 * ETL not been listed). The fix is one table line, not a heuristic that guesses which
 * three-letter words are acronyms — "git" and "sql" have the same shape.
 */
export function titleCasePlain(name: string): string {
  const s = name.trim();
  if (!/^[a-z][a-z' -]*$/.test(s)) return s;
  return s
    .split(/\s+/)
    .map((word, wi) =>
      word
        .split('-')
        .map((part, pi) =>
          (wi > 0 || pi > 0) && SMALL_WORDS.has(part)
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1),
        )
        .join('-'),
    )
    .join(' ');
}

/**
 * The key two spellings of one skill share. Anything absent from the table is its own
 * identity, keyed on its normalised form so at least case and spacing still collapse.
 */
export function skillIdentity(name: string): string {
  const n = normalizeSkill(name);
  const canonical = ALIASES[n];
  return canonical ? canonical.toLowerCase() : n;
}

/**
 * The name to print. The table's spelling where it has one; otherwise what the user
 * wrote, title-cased only if they wrote it entirely in lowercase (`titleCasePlain`).
 */
export function canonicalSkillName(name: string): string {
  const known = ALIASES[normalizeSkill(name)];
  if (known) return known;
  const trimmed = name.trim();
  const plain = titleCasePlain(trimmed);
  if (plain !== trimmed) return plain;

  // A name that is already partly capitalised gets its lowercase words brought into
  // line: "Prompt engineering" printed beside "Random Forest" read as a mistake. Only
  // all-lowercase words change — acronyms, versions and "C++" are left as written — and a
  // word lowercase by convention ("pandas") keeps the table's spelling. Whole aliases are
  // NOT looked up per word: "RAG" expands to "Retrieval-Augmented Generation (RAG)".
  return trimmed
    .split(/\s+/)
    .map((word, i) => {
      if (!/^[a-z][a-z'-]*$/.test(word)) return word;
      if (i > 0 && SMALL_WORDS.has(word)) return word;
      const table = ALIASES[normalizeSkill(word)];
      if (table && table.toLowerCase() === word) return table;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Every spelling sharing this skill's identity, normalised.
 *
 * The keyword gate needs this: a posting asking for "Node.js" against a resume that says
 * "Node" is a match, and the gate can only know that by being handed the siblings.
 */
export function skillAliases(name: string): string[] {
  const id = skillIdentity(name);
  const out = new Set<string>([normalizeSkill(name)]);
  for (const [spelling, canonical] of Object.entries(ALIASES)) {
    if (canonical.toLowerCase() === id) out.add(spelling);
  }
  return [...out].filter(Boolean);
}

/**
 * Picks the better of two tellings of one skill, as `mergeRoles` does for jobs.
 *
 * The canonical name wins wherever the table knows one, because that is the spelling a
 * parser and a recruiter both expect. Otherwise the first telling wins: with no table
 * entry there is nothing to prefer, and stability beats an arbitrary rule.
 */
export function mergeSkillNames(a: string, b: string): string {
  const canonical = ALIASES[normalizeSkill(a)] ?? ALIASES[normalizeSkill(b)];
  return canonical ?? titleCasePlain(a);
}

/** Collapses a list of skill names to one entry per real skill, order preserved. */
export function dedupeSkillNames(names: string[]): string[] {
  const byIdentity = new Map<string, string>();
  for (const name of names) {
    if (!name?.trim()) continue;
    const key = skillIdentity(name);
    if (!key) continue;
    const existing = byIdentity.get(key);
    byIdentity.set(
      key,
      existing ? mergeSkillNames(existing, name) : canonicalSkillName(name),
    );
  }
  return [...byIdentity.values()];
}

/**
 * The same collapse over anything carrying a skill name. The first record seen survives
 * — retrieval has already ordered them by relevance, and re-ordering here would quietly
 * undo that.
 */
export function dedupeBySkillIdentity<T>(items: T[], nameOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = skillIdentity(nameOf(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

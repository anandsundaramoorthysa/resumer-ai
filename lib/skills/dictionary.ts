/**
 * What kind of thing a few hundred named skills are — the first and cheapest layer of
 * ./categories.ts.
 *
 * Data, not logic: one list per category, in the spelling a person would type. Lookup goes
 * through `skillIdentity`, so every spelling the alias table knows ("React.js", "reactjs",
 * "react") finds the same entry, and matching is case- and punctuation-insensitive.
 *
 * The boundaries, because the hard cases are all on them:
 *
 *   language    something you write code in, including query and markup languages.
 *   framework   a library or framework you import and build on.
 *   tool        a program you operate: editors, trackers, CLIs, analytics suites.
 *   platform    something hosted that you connect to: clouds, databases, APIs, services.
 *   method      something you know how to do: techniques, disciplines, practices.
 *   soft-skill  how you work with people.
 *
 * A name in two of these on a real resume is filed where a recruiter would look for it:
 * Node.js is a platform you deploy on rather than a library you import, Random Forest is
 * the technique rather than the implementation, and SQL is the language, while PostgreSQL
 * is the platform.
 *
 * Adding an entry is the cheapest way to improve the classifier, and it needs no model
 * call and no network: prefer it to anything else.
 */

import { skillIdentity } from './identity';
import type { SkillCategory } from './categories';

const LANGUAGES = [
  'python', 'javascript', 'typescript', 'java', 'c', 'c++', 'c#', 'go', 'rust', 'ruby',
  'php', 'swift', 'kotlin', 'dart', 'scala', 'r', 'matlab', 'perl', 'lua', 'haskell',
  'elixir', 'erlang', 'clojure', 'f#', 'objective-c', 'visual basic', 'vb.net', 'cobol',
  'fortran', 'assembly', 'bash', 'shell scripting', 'powershell', 'sql', 'pl/sql',
  't-sql', 'html', 'css', 'sass', 'scss', 'less', 'xml', 'yaml', 'json', 'markdown',
  'latex', 'solidity', 'groovy', 'julia', 'ocaml', 'prolog', 'abap', 'apex', 'sas',
  'stata', 'emacs lisp', 'lisp', 'scheme', 'zig', 'nim', 'crystal', 'vhdl', 'verilog',
  'graphql', 'sparql', 'regex',
];

const FRAMEWORKS = [
  'react', 'angular', 'angularjs', 'vue', 'svelte', 'next.js', 'nuxt', 'remix', 'astro',
  'gatsby', 'jquery', 'ember', 'backbone.js', 'express', 'nestjs', 'fastify', 'koa',
  'django', 'flask', 'fastapi', 'ruby on rails', 'laravel', 'symfony', 'codeigniter',
  'spring', 'spring boot', 'hibernate', 'asp.net', 'blazor', '.net', 'gin', 'phoenix',
  'tailwind css', 'bootstrap', 'material ui', 'chakra ui', 'shadcn/ui', 'ant design',
  'bulma', 'redux', 'mobx', 'zustand', 'react query', 'rxjs', 'three.js', 'd3.js',
  'chart.js', 'recharts', 'framer motion', 'gsap', 'leaflet', 'socket.io', 'jest',
  'vitest', 'mocha', 'chai', 'cypress', 'playwright', 'selenium', 'puppeteer',
  'testing library', 'pytest', 'unittest', 'junit', 'testng', 'rspec', 'numpy', 'pandas',
  'scipy', 'scikit-learn', 'tensorflow', 'keras', 'pytorch', 'xgboost', 'lightgbm',
  'catboost', 'statsmodels', 'matplotlib', 'seaborn', 'plotly', 'bokeh', 'opencv',
  'spacy', 'nltk', 'gensim', 'transformers', 'langchain', 'llamaindex', 'streamlit',
  'gradio', 'dash', 'flutter', 'react native', 'ionic', 'electron', 'tauri', 'qt',
  'swiftui', 'jetpack compose', 'pyspark', 'dask', 'polars', 'beautifulsoup', 'scrapy',
  'prisma', 'sequelize', 'typeorm', 'mongoose', 'sqlalchemy', 'alembic', 'drizzle orm',
  'apollo', 'trpc', 'axios', 'lodash', 'moment.js', 'day.js', 'zod', 'pydantic',
  'celery', 'rabbitmq client', 'openai sdk', 'vercel ai sdk', 'particles.js',
];

const TOOLS = [
  'git', 'docker', 'kubernetes', 'terraform', 'ansible', 'puppet', 'chef', 'vagrant',
  'jenkins', 'circleci', 'github actions', 'gitlab ci', 'travis ci', 'argo cd',
  'webpack', 'vite', 'rollup', 'parcel', 'babel', 'eslint', 'prettier', 'npm', 'yarn',
  'pnpm', 'pip', 'poetry', 'conda', 'maven', 'gradle', 'make', 'cmake', 'bazel',
  'vs code', 'visual studio', 'intellij idea', 'pycharm', 'webstorm', 'eclipse',
  'xcode', 'android studio', 'vim', 'neovim', 'emacs', 'org mode', 'jupyter',
  'google colab', 'anaconda', 'rstudio', 'spss', 'jira', 'confluence', 'trello',
  'asana', 'monday.com', 'notion', 'slack', 'microsoft teams', 'microsoft 365',
  'microsoft copilot', 'google workspace', 'figma', 'sketch', 'adobe xd', 'photoshop',
  'illustrator', 'indesign', 'premiere pro', 'after effects', 'canva', 'blender',
  'postman', 'insomnia', 'swagger', 'curl', 'wireshark', 'nmap', 'burp suite',
  'metasploit', 'tableau', 'power bi', 'looker', 'qlik', 'excel', 'google sheets',
  'google analytics', 'google search console', 'google tag manager', 'ahrefs',
  'semrush', 'moz', 'screaming frog', 'hotjar', 'mixpanel', 'amplitude', 'segment',
  'datadog', 'grafana', 'prometheus', 'kibana', 'splunk', 'sentry', 'new relic',
  'pagerduty', 'sonarqube', 'airflow', 'dbt', 'prefect', 'talend', 'informatica',
  'linux', 'ubuntu', 'macos', 'windows server', 'unix', 'ffmpeg', 'imagemagick',
  'unity', 'unreal engine', 'autocad', 'solidworks', 'matlab simulink', 'latex editor',
  'obs studio', 'zoom', 'loom', 'zapier', 'n8n', 'make.com', 'version control',
];

const PLATFORMS = [
  'aws', 'amazon web services', 'azure', 'google cloud', 'gcp', 'heroku', 'netlify',
  'vercel', 'digitalocean', 'linode', 'cloudflare', 'firebase', 'cloud firestore',
  'supabase', 'appwrite', 'render', 'railway', 'fly.io', 'amazon ec2', 'amazon s3',
  'aws lambda', 'amazon rds', 'cloudfront', 'sagemaker', 'bigquery', 'redshift',
  'snowflake', 'databricks', 'athena', 'aws glue', 'kinesis', 'amazon sqs', 'amazon sns',
  'amazon eks', 'amazon ecs', 'app engine', 'cloud run', 'cloud functions',
  'postgresql', 'mysql', 'mariadb', 'sqlite', 'mongodb', 'redis', 'cassandra',
  'elasticsearch', 'opensearch', 'neo4j', 'influxdb', 'couchdb', 'dynamodb',
  'oracle database', 'microsoft sql server', 'cosmos db', 'pinecone', 'weaviate',
  'qdrant', 'chroma', 'milvus', 'upstash', 'planetscale', 'neon', 'kafka', 'activemq',
  'nats', 'mqtt', 'rabbitmq', 'stripe', 'paypal', 'razorpay', 'twilio', 'sendgrid',
  'mailgun', 'resend', 'auth0', 'clerk', 'okta', 'keycloak', 'openai api', 'gemini api',
  'groq api', 'anthropic api', 'hugging face', 'replicate', 'ollama', 'shopify',
  'wordpress', 'contentful', 'sanity', 'strapi', 'salesforce', 'hubspot', 'zoho',
  'servicenow', 'sap', 'telegram bot api', 'whatsapp business api', 'discord api',
  'slack api', 'github api', 'google maps api', 'youtube api', 'stripe api', 'github',
  'gitlab', 'bitbucket', 'node.js', 'deno', 'bun', 'nginx', 'apache', 'tomcat',
  'graphql api', 'rest api', 'websockets', 'grpc', 'vector database',
  'content management system', 'payment gateways', 'data lake', 'message queue',
];

const METHODS = [
  'machine learning', 'deep learning', 'artificial intelligence', 'generative ai',
  'natural language processing', 'computer vision', 'reinforcement learning',
  'supervised learning', 'unsupervised learning', 'transfer learning',
  'feature engineering', 'model deployment', 'mlops', 'llmops', 'data science',
  'data analysis', 'data analytics', 'data visualization', 'data modeling',
  'data mining', 'data cleaning', 'data preparation', 'data engineering', 'etl',
  'data warehousing', 'business intelligence', 'statistics', 'statistical analysis',
  'regression', 'linear regression', 'logistic regression', 'classification',
  'clustering', 'segmentation', 'time series analysis', 'forecasting',
  'anomaly detection', 'hypothesis testing', 'a/b testing', 'experimentation',
  'bayesian statistics', 'probability', 'exploratory data analysis',
  'dimensionality reduction', 'principal component analysis', 'recommendation systems',
  'sentiment analysis', 'topic modeling', 'optical character recognition',
  'speech recognition', 'prompt engineering', 'retrieval-augmented generation',
  'fine-tuning', 'vector search', 'semantic search', 'embeddings', 'agentic ai',
  'ai agents', 'random forest', 'gradient boosting', 'decision trees',
  'neural networks', 'convolutional neural networks', 'recurrent neural networks',
  'transformers', 'web development', 'front-end development', 'back-end development',
  'full-stack development', 'mobile development', 'game development',
  'responsive web design', 'web design', 'ui design', 'ux design', 'ui/ux design',
  'user research', 'wireframing', 'prototyping', 'accessibility',
  'search engine optimization', 'search engine marketing', 'content marketing',
  'digital marketing', 'email marketing', 'social media marketing',
  'influencer marketing', 'instagram marketing', 'growth hacking', 'copywriting',
  'technical writing', 'content writing', 'blogging', 'agile', 'scrum', 'kanban',
  'project management', 'product management', 'program management',
  'release management', 'risk management', 'change management',
  'requirements gathering', 'business analysis', 'process improvement', 'six sigma',
  'lean', 'devops', 'ci/cd', 'continuous integration', 'continuous deployment',
  'infrastructure as code', 'site reliability engineering', 'observability',
  'monitoring', 'incident response', 'test-driven development',
  'behavior-driven development', 'unit testing', 'integration testing',
  'end-to-end testing', 'manual testing', 'test automation', 'performance testing',
  'load testing', 'security testing', 'penetration testing', 'threat modeling',
  'code review', 'pair programming', 'refactoring', 'design patterns',
  'object-oriented programming', 'functional programming', 'data structures',
  'algorithms', 'system design', 'distributed systems', 'microservices',
  'api design', 'database design', 'query optimization', 'caching', 'scalability',
  'cloud architecture', 'serverless architecture', 'event-driven architecture',
  'domain-driven design', 'technical documentation', 'cryptography',
  'network security', 'cybersecurity', 'ethical hacking', 'digital forensics',
  'financial modeling', 'budgeting', 'accounting', 'bookkeeping', 'market research',
  'competitive analysis', 'customer segmentation', 'supply chain management',
  'inventory management', 'quality assurance', 'curriculum design', 'data governance',
  'responsible ai', 'chatbot development', 'telegram bot development', 'chatbot',
  'tf-idf', 'large language models', 'large language model', 'agentic workflows', 'time series', 'blockchain',
  'word embeddings', 'named entity recognition', 'image classification',
  'software project management', 'blockchain development',
];

const SOFT_SKILLS = [
  'communication', 'written communication', 'verbal communication',
  'presentation skills', 'public speaking', 'storytelling', 'active listening',
  'teamwork', 'collaboration', 'cross-functional collaboration', 'leadership',
  'team leadership', 'people management', 'mentoring', 'coaching',
  'conflict resolution', 'negotiation', 'persuasion', 'stakeholder management',
  'client management', 'customer service', 'empathy', 'emotional intelligence',
  'adaptability', 'flexibility', 'resilience', 'time management', 'prioritization',
  'organization', 'attention to detail', 'critical thinking', 'problem solving',
  'decision making', 'creativity', 'innovation', 'curiosity', 'self-motivation',
  'work ethic', 'accountability', 'ownership', 'delegation', 'interviewing',
  'onboarding', 'business development', 'sales', 'account management',
  'entrepreneurship', 'networking', 'teaching', 'training',
];

const BY_CATEGORY: Array<[SkillCategory, string[]]> = [
  ['language', LANGUAGES],
  ['framework', FRAMEWORKS],
  ['tool', TOOLS],
  ['platform', PLATFORMS],
  ['method', METHODS],
  ['soft-skill', SOFT_SKILLS],
];

/**
 * Keyed by skill identity, so the alias table's spellings all land on one entry. Built
 * once at module load; the lists above are the source of truth.
 */
const DICTIONARY: Map<string, SkillCategory> = (() => {
  const map = new Map<string, SkillCategory>();
  for (const [category, names] of BY_CATEGORY) {
    for (const name of names) {
      const key = skillIdentity(name);
      if (key && !map.has(key)) map.set(key, category);
    }
  }
  return map;
})();

/**
 * Every named technology the dictionary lists (languages, frameworks, tools, platforms),
 * as typed. The grounding guard builds its lowercase-entity lexicon from this, so a tool
 * written in lower case ("kubernetes") is still recognised as a name.
 */
export const DICTIONARY_TERMS: readonly string[] = [...LANGUAGES, ...FRAMEWORKS, ...TOOLS, ...PLATFORMS];

/** How many skills the dictionary knows — reported by the classifier's own tests. */
export const DICTIONARY_SIZE = DICTIONARY.size;

export function dictionaryCategory(name: string): SkillCategory | null {
  return DICTIONARY.get(skillIdentity(name)) ?? null;
}

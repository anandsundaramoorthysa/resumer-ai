/**
 * The skill classifier — lib/skills/categories.ts, ./dictionary.ts and the pure half of
 * ./classify-ai.ts. Two kinds of case: the owner's real skills, which must all be placed,
 * and the look-alikes where a wrong answer would be confidently wrong.
 */

import { classifySkill, nameVariants, suggestedSkillCategory } from '../lib/skills/categories';
import { DICTIONARY_SIZE } from '../lib/skills/dictionary';
import { acceptClassifications, isShareableSkillName } from '../lib/skills/classify-ai';
import { skillIdentity } from '../lib/skills/identity';
import { suite, test, assert } from './harness.mjs';

const cat = (n: string) => suggestedSkillCategory(n);

suite('skill classifier — the dictionary', () => {
  test('it knows several hundred skills', () => {
    assert.ok(DICTIONARY_SIZE > 600, `${DICTIONARY_SIZE}`);
  });

  test('every spelling the alias table knows lands on one answer', () => {
    assert.equal(cat('React'), 'framework');
    assert.equal(cat('React.js'), 'framework');
    assert.equal(cat('reactjs'), 'framework');
    assert.equal(cat('nodejs'), 'platform');
  });

  test('the boundaries a recruiter reads by', () => {
    assert.equal(cat('SQL'), 'language');
    assert.equal(cat('PostgreSQL'), 'platform');
    assert.equal(cat('Node.js'), 'platform');
    assert.equal(cat('Random Forest'), 'method');
    assert.equal(cat('scikit-learn'), 'framework');
    assert.equal(cat('Git'), 'tool');
    assert.equal(cat('GitHub'), 'platform');
    assert.equal(cat('Communication'), 'soft-skill');
  });

  test('languages that differ by a symbol are each a language', () => {
    assert.equal(cat('C'), 'language');
    assert.equal(cat('C++'), 'language');
    assert.equal(cat('C#'), 'language');
  });
});

suite('skill classifier — variants of a name', () => {
  test('an acronym in brackets, an acronym alone, a plural', () => {
    assert.equal(cat('Natural Language Processing (NLP)'), 'method');
    assert.equal(cat('NLP'), 'method');
    assert.equal(cat('ML'), 'method');
    assert.equal(cat('LLMs'), 'method');
    assert.equal(cat('Vector Databases'), 'platform');
  });

  test('a qualifying tail, and a name that is two things', () => {
    assert.equal(cat('RAG pipelines'), 'method');
    assert.equal(cat('Emacs / Org Mode'), 'tool');
  });

  test('the variants are tried most faithful first', () => {
    const v = nameVariants('Natural Language Processing (NLP)');
    assert.equal(v[0], 'Natural Language Processing (NLP)');
    assert.ok(v.includes('NLP'));
  });
});

suite('skill classifier — shapes, and knowing when to say nothing', () => {
  test('a name nobody lists is placed by its shape, and marked as a likelier guess', () => {
    const api = classifySkill('Zephyr Payments API');
    assert.deepEqual(api, { category: 'platform', confidence: 'medium', source: 'pattern' });
    assert.equal(cat('Warehouse Automation'), 'method');
    assert.equal(cat('Kitchen Display Dashboard'), 'tool');
  });

  test('a name with no telling shape gets no answer at all', () => {
    assert.equal(classifySkill('Tally ERP'), null);
    assert.equal(classifySkill('Marimo'), null);
    assert.equal(classifySkill(''), null);
  });

  test('all 103 of the owner’s skills are placed', () => {
    const owner = ['Technical Writing', 'Generative AI', 'SQL', 'Machine Learning', 'Deep Learning', 'Convolutional Neural Networks (CNN)', 'Telegram Bot Development', 'Chatbot Development', 'Natural Language Processing (NLP)', 'Optical Character Recognition (OCR)', 'Jest', 'Public Speaking', 'Time Management', 'Presentation Skills', 'Instagram Marketing', 'React', 'AI technologies', 'ML', 'segmentation', 'classification', 'clustering', 'AI/ML', 'TypeScript', 'Next.js', 'Tailwind CSS', 'JavaScript', 'HTML', 'CSS', 'Node.js', 'Express.js', 'Python', 'Flask', 'PostgreSQL', 'scikit-learn', 'PySpark', 'Random Forest', 'XGBoost', 'LightGBM', 'NLP', 'TF-IDF', 'LLMs', 'RAG pipelines', 'Prompt engineering', 'Vector search', 'Gemini API', 'Groq API', 'Flutter', 'Firebase', 'Git', 'Docker', 'Hugging Face', 'Emacs / Org Mode', 'VS Code Extension API', 'RAG', 'Vector Database', 'Chatbot', 'LLM', 'AI', 'Data Science', 'Vector Databases', 'Retrieval-Augmented Generation (RAG)', 'Large Language Models (LLM)', 'Agentic AI Development', 'Agentic Workflows', 'Exploratory Data Analysis', 'Full-Stack Development', 'Gradient Boosting', 'Data Preparation', 'Search Engine Optimization (SEO)', 'People Management', 'Business Development', 'Amazon EC2', 'Cloud Firestore', 'Payment Gateways', 'API Development', 'GitHub', 'Version Control', 'Markdown', 'Emacs', 'Emacs Lisp', 'Org Mode', 'Content Management Systems (CMS)', 'React.js', 'MySQL', 'Bootstrap', 'jQuery', 'Front-End Development', 'Web Development', 'Responsive Web Design', 'C', 'C++', 'Java', 'Dart', 'Streamlit', 'Software Project Management', 'Blockchain', 'Artificial Intelligence (AI)', 'Responsible AI', 'Microsoft 365', 'Microsoft Copilot', 'Blogging', 'time series', 'statistics'];
    assert.equal(owner.length, 103);
    const missed = owner.filter((n) => !classifySkill(n));
    assert.deepEqual(missed, []);
  });
});

suite('skill classifier — the model’s answers', () => {
  const asked = new Set([skillIdentity('Tally ERP'), skillIdentity('Patient Triage')]);

  test('only answers to what was asked, in one of the six categories, first answer wins', () => {
    const out = acceptClassifications(asked, [
      { name: 'Tally ERP', category: 'Tool' },
      { name: 'Patient Triage', category: 'method' },
      { name: 'Patient Triage', category: 'tool' },
      { name: 'Kubernetes', category: 'tool' },
      { name: 'Tally ERP', category: 'discipline' },
    ]);
    assert.deepEqual([...out], [[skillIdentity('Tally ERP'), 'tool'], [skillIdentity('Patient Triage'), 'method']]);
  });

  test('personal-looking names are never sent or cached', () => {
    assert.ok(isShareableSkillName('Tally ERP'));
    assert.ok(!isShareableSkillName('me@example.com'));
    assert.ok(!isShareableSkillName('https://mysite.dev'));
    assert.ok(!isShareableSkillName('I built the whole thing myself over two long summers'));
    assert.ok(!isShareableSkillName('42'));
  });
});

/**
 * Core domain types for Resumer AI.
 * Mirrors specs/design.md §3. Requirement IDs referenced in comments.
 */

/**
 * Where a fact came from. Load-bearing: lib/sync/reconcile.ts only ever rewrites
 * `github-sync` rows, so every other value is a promise that a sync will not touch it.
 */
export type RecordSource = 'manual' | 'github-sync' | 'ai-import' | 'linkedin';

export type RoleCategory =
  | 'seo'
  | 'full-stack'
  | 'ai-engineer'
  | 'project-manager'
  | 'data'
  | 'design'
  | 'general';

/** REQ-1.1 — atomic, tagged profile facts. */
export interface ProfileRecordBase {
  id: string;
  userId: string;
  source: RecordSource; // REQ-1.2
  contentHash: string; // REQ-1.2 / REQ-2.4 reconciliation key
  tags: string[]; // skills/keywords this record demonstrates
  flaggedForRemoval: boolean; // REQ-2.4 — flagged, never auto-deleted
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillRecord extends ProfileRecordBase {
  type: 'skill';
  name: string;
  category: 'language' | 'framework' | 'tool' | 'platform' | 'soft-skill';
  proficiency?: 'familiar' | 'proficient' | 'expert';
  yearsOfExperience?: number;
  lastUsed?: Date;
}

export interface ExperienceBulletRecord extends ProfileRecordBase {
  type: 'experience-bullet';
  roleId: string;
  /** The full bullet as written. Rewrites may rephrase this but never exceed it. */
  text: string;
  /** Structured evidence — drives the evidence-quality score (REQ-5.2). */
  action: string;
  scale?: string;
  outcome?: string;
}

export interface RoleRecord {
  id: string;
  userId: string;
  title: string;
  company: string;
  location?: string;
  startDate: string; // ISO-ish 'YYYY-MM'
  endDate: string | 'present';
  source: RecordSource;
  contentHash: string;
}

export interface ProjectRecord extends ProfileRecordBase {
  type: 'project';
  name: string;
  /**
   * Optional, because the importer can legitimately produce a project without one.
   *
   * `lib/profile/forms.ts` does not mark description required — a project is identified
   * by its name and stack — and `sanitize()` in lib/import/commit.ts omits a key whose
   * value is blank rather than storing an empty string. So a real import wrote a project
   * with no `description` key at all, while this said `string`. Nothing caught it: the
   * record's `data` is JSONB, read back with a cast. The assembler then trusted the type
   * and put `undefined` into a resume item, and the crash surfaced three layers away as
   * "Cannot read properties of undefined (reading 'replace')" — with the whole draft
   * lost. Optional here makes the compiler ask about it at every read.
   */
  description?: string;
  stack: string[];
  links: string[];
  impactMetrics: string[];
}

export interface EducationRecord extends ProfileRecordBase {
  type: 'education';
  institution: string;
  credential: string;
  field?: string;
  startDate?: string;
  endDate?: string;
}

export interface CertificationRecord extends ProfileRecordBase {
  type: 'certification';
  name: string;
  issuer: string;
  issuedDate?: string;
  credentialUrl?: string;
}

export interface AchievementRecord extends ProfileRecordBase {
  type: 'achievement';
  title: string;
  description: string;
  date?: string;
}

/** A written professional summary. At most one is used; the newest wins. */
export interface SummaryRecord extends ProfileRecordBase {
  type: 'summary';
  text: string;
}

/**
 * Peer-reviewed or formally published work. Kept distinct from `writing` because the
 * two carry different weight: a conference paper with a DOI is evidence of research,
 * a blog post is evidence of communication. Both belong on a resume; conflating them
 * would overstate the second and bury the first.
 */
export interface PublicationRecord extends ProfileRecordBase {
  type: 'publication';
  title: string;
  venue: string;
  date?: string;
  doi?: string;
  isbn?: string;
  status?: 'published' | 'under-review' | 'preprint';
  coAuthors?: string[];
  url?: string;
}

/** Articles, blog posts, technical writing. */
export interface WritingRecord extends ProfileRecordBase {
  type: 'writing';
  title: string;
  venue: string;
  date?: string;
  url?: string;
}

/** Competitive wins and formal recognition — separated from softer achievements. */
export interface AwardRecord extends ProfileRecordBase {
  type: 'award';
  title: string;
  issuer?: string;
  date?: string;
  description?: string;
}

export interface LanguageRecord extends ProfileRecordBase {
  type: 'language';
  name: string;
  proficiency?: 'native' | 'fluent' | 'professional' | 'conversational' | 'basic';
  credential?: string;
}

/** Organised or volunteered-at events, community roles, leadership. */
export interface VolunteeringRecord extends ProfileRecordBase {
  type: 'volunteering';
  role: string;
  organization: string;
  date?: string;
  description?: string;
}

/** Interests and hobbies. Lowest-weight section; included only when space allows. */
export interface InterestRecord extends ProfileRecordBase {
  type: 'interest';
  name: string;
}

export type ProfileRecord =
  | SkillRecord
  | ExperienceBulletRecord
  | ProjectRecord
  | EducationRecord
  | CertificationRecord
  | AchievementRecord
  | SummaryRecord
  | PublicationRecord
  | WritingRecord
  | AwardRecord
  | LanguageRecord
  | VolunteeringRecord
  | InterestRecord;

/** Contact block — rendered in the document body, never a header/footer (REQ-6.1). */
export interface ContactInfo {
  fullName: string;
  email: string;
  phone?: string;
  location?: string;
  portfolioUrl?: string;
  githubUrl?: string;
  linkedinUrl?: string;
}

/** REQ-1.3 — reserved for Phase 10 autofill; unused by the generator. */
export interface ApplicationFormFields {
  userId: string;
  workAuthorization?: string;
  visaSponsorshipNeeded?: boolean;
  eeoAnswers?: Record<string, string>;
  salaryExpectation?: string;
  noticePeriod?: string;
}

/** REQ-3.3 — normalized job input, whatever the source format was. */
export interface JobRequirement {
  roleTitle: string;
  company?: string;
  seniority: 'intern' | 'entry' | 'mid' | 'senior' | 'lead' | 'unknown';
  category: RoleCategory;
  requiredSkills: string[];
  preferredSkills: string[];
  responsibilities: string[];
  /** Exact terms an ATS keyword filter would scan for. */
  atsKeywords: string[];
  companyContext?: string;
  tone: 'startup' | 'corporate' | 'agency' | 'neutral';
  yearsOfExperienceRequired?: number;
  /** REQ-3.4 sanity-check output. */
  confidence: number; // 0..1
  flags: string[];
}

export type SectionKey =
  | 'summary'
  | 'skills'
  | 'experience'
  | 'projects'
  | 'education'
  | 'certifications'
  | 'publications'
  | 'awards'
  | 'achievements'
  | 'volunteering'
  | 'languages'
  | 'interests';

export interface ResumeItem {
  text: string;
  /** Traceability — which profile record this line came from. */
  sourceRecordId: string | null;
}

export interface ResumeSection {
  key: SectionKey;
  /** Must match the allow-list in lib/render/headings.ts (REQ-6.1). */
  heading: string;
  items: ResumeItem[];
  /** Experience/projects group items under a parent (role or project name). */
  groups?: Array<{
    title: string;
    subtitle?: string;
    dateRange?: string;
    items: ResumeItem[];
  }>;
}

export interface ResumeDocument {
  id: string;
  userId: string;
  contact: ContactInfo;
  sections: ResumeSection[];
  jobRequirement: JobRequirement | null; // null for a baseline resume (REQ-6.7)
  renderMode: 'ats-strict' | 'presentation';
  /** REQ-9.2 — hashes of every source record used, frozen at export. */
  recordHashSnapshot: string[];
  createdAt: Date;
}

/** REQ-5.2 — scoring result. */
export interface QualityGateResult {
  keywordGatePassed: boolean;
  keywordCoveragePct: number;
  missingKeywords: string[];
  formattingScore: number; // 0..1, weight 0.30
  evidenceScore: number; // 0..1, weight 0.30
  skillsCompletenessScore: number; // 0..1, weight 0.40
  overall: number; // 0..10
  passed: boolean; // overall >= 8.5 && keywordGatePassed
  iterations: number;
  critiques: Critique[];
  /**
   * Set when the loop stopped for a reason other than passing (REQ-5.5, REQ-5.6).
   *
   * `no-progress` means it stopped BEFORE the cap because another pass could not have
   * changed anything — the revision returned the same document, or the score stopped
   * moving. Distinct from `iteration-cap`, which means the attempts were used.
   */
  haltReason?: 'iteration-cap' | 'budget-cap' | 'unfixable-gap' | 'no-progress';
  haltExplanation?: string;
}

export interface Critique {
  subScore: 'keywords' | 'formatting' | 'evidence' | 'skills';
  message: string;
  /** Which section/item to revise — keeps revision targeted (REQ-5.4). */
  targetSectionKey?: SectionKey;
  targetItemIndex?: number;
}

/** Streamed to the browser as the pipeline runs (REQ-8.1). */
export type PipelineStage =
  | 'sync'
  | 'understand'
  | 'retrieve'
  | 'draft'
  | 'score'
  | 'finalize';

export interface PipelineEvent {
  stage: PipelineStage;
  status: 'running' | 'done' | 'error';
  /** Human-readable line shown in the live panel. */
  message: string;
  /** Optional structured detail (score readouts, counts). */
  detail?: Record<string, unknown>;
  at: number;
}

export interface ApplicationEntry {
  id: string;
  userId: string;
  resumeSnapshotId: string; // REQ-9.2
  roleTitle: string;
  company: string;
  category: RoleCategory;
  score: number;
  status: 'draft' | 'applied' | 'interview' | 'rejected' | 'offer';
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

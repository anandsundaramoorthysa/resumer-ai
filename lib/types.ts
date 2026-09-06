/**
 * Core domain types for Resumer AI.
 * Mirrors specs/design.md §3. Requirement IDs referenced in comments.
 */

export type RecordSource = 'manual' | 'github-sync' | 'ai-import';

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
  description: string;
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

export type ProfileRecord =
  | SkillRecord
  | ExperienceBulletRecord
  | ProjectRecord
  | EducationRecord
  | CertificationRecord
  | AchievementRecord;

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
  | 'achievements';

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
  /** Set when the loop stopped for a reason other than passing (REQ-5.5, REQ-5.6). */
  haltReason?: 'iteration-cap' | 'budget-cap' | 'unfixable-gap';
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

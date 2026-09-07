/**
 * The gaps only the user can fill — AUDIT.md #2 and #5.
 *
 * Both were checked against the portfolio source and are data problems, not parsing
 * bugs: `experienceData.ts` carries no accomplishment prose, and none of the 32 projects
 * state an outcome. Nothing downstream can fix that, so the honest response is to make
 * the hole visible on /profile with somewhere to type the missing facts.
 *
 * Pure so it can be unit-tested without a database.
 */

import type { ProfileRecord, RoleRecord } from '../types';
import { extractNumbers } from '../generate/grounding';

export interface RoleGap {
  roleId: string;
  title: string;
  company: string;
}

export interface ProjectGap {
  recordId: string;
  name: string;
}

export interface ProfileGaps {
  totalRoles: number;
  rolesWithoutBullets: RoleGap[];
  totalProjects: number;
  projectsWithoutMetrics: ProjectGap[];
  /** One line for the top of the page, or null when there is nothing to report. */
  headline: string | null;
}

/**
 * Whether a project records something measurable.
 *
 * Only `impactMetrics` counts, not the description. A description reaches for a number
 * constantly without measuring anything — "Built with Next.js 14" — and treating that as
 * an outcome would clear the flag on projects that still have no result recorded.
 */
export function hasMeasurableOutcome(impactMetrics: string[]): boolean {
  return impactMetrics.some((m) => extractNumbers(m).length > 0);
}

export function findProfileGaps(
  roles: RoleRecord[],
  records: ProfileRecord[],
): ProfileGaps {
  const withBullets = new Set(
    records
      .filter((r) => r.type === 'experience-bullet' && !r.flaggedForRemoval)
      .map((r) => (r as Extract<ProfileRecord, { type: 'experience-bullet' }>).roleId),
  );

  const rolesWithoutBullets = roles
    .filter((r) => !withBullets.has(r.id))
    .map((r) => ({ roleId: r.id, title: r.title, company: r.company }));

  const projects = records.filter(
    (r): r is Extract<ProfileRecord, { type: 'project' }> =>
      r.type === 'project' && !r.flaggedForRemoval,
  );
  const projectsWithoutMetrics = projects
    .filter((p) => !hasMeasurableOutcome(p.impactMetrics ?? []))
    .map((p) => ({ recordId: p.id, name: p.name }));

  const parts: string[] = [];
  if (rolesWithoutBullets.length > 0) {
    parts.push(
      `${rolesWithoutBullets.length} of ${roles.length} role${
        roles.length === 1 ? '' : 's'
      } have no accomplishments recorded`,
    );
  }
  if (projectsWithoutMetrics.length > 0) {
    parts.push(
      `${projectsWithoutMetrics.length} of ${projects.length} project${
        projects.length === 1 ? '' : 's'
      } have no measurable outcome`,
    );
  }

  return {
    totalRoles: roles.length,
    rolesWithoutBullets,
    totalProjects: projects.length,
    projectsWithoutMetrics,
    headline: parts.length > 0 ? `${parts.join(' · ')}.` : null,
  };
}

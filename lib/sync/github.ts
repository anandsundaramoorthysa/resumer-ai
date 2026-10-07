import { safeFetchText } from '@/lib/net/safe-fetch';
/**
 * GitHub portfolio sync — REQ-2.1 through REQ-2.5.
 *
 * The SHA gate (REQ-2.2 / NFR-7) is the important part: one cheap API call decides
 * whether any of the expensive work is needed at all. Re-parsing a repo and paying for
 * an AI extraction pass on every single draft would be wasteful; comparing the latest
 * commit SHA to the last one we synced costs effectively nothing.
 */

const GH = 'https://api.github.com';

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * The characters GitHub allows in an account or repository name. Everything else is
 * refused here rather than encoded and sent, because a name that cannot exist is not a
 * name — it is somebody shaping our request.
 *
 * What that shaping buys, before the encoding below closes it: `owner/..` normalises
 * away a path segment under URL parsing, so `/repos/owner/../commits/main` reaches a
 * different endpoint than the one this code believes it is calling, and a `?` or `#`
 * turns the rest of the path into query or fragment. No privilege comes with it — the
 * request carries the user's own token, or an installation token limited to
 * `contents: read` on repositories they chose to grant — which is why this was rated
 * low. It is still a primitive that should not exist.
 */
const SEGMENT_CHARSET = /^[A-Za-z0-9._-]+$/;

function validSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 100) return false;
  if (!SEGMENT_CHARSET.test(segment)) return false;
  // `.` and `..` pass the charset test and are the whole traversal trick, so they are
  // named explicitly. So is any other all-dots segment.
  if (/^\.+$/.test(segment)) return false;
  return true;
}

const GITHUB_HOST = /^(www\.)?github\.com$/i;

/**
 * "owner/repo", "github.com/owner/repo" (no scheme, as people paste it),
 * "https://github.com/owner/repo.git/", "git@github.com:owner/repo.git" — and nothing
 * from another host: `https://gitlab.com/o/r` used to parse as owner "gitlab.com", repo
 * "o", and the sync would go looking for a repository that is not the one named.
 */
export function parseRepoRef(input: string): RepoRef | null {
  let s = input.trim();
  const ssh = /^git@github\.com:(.+)$/i.exec(s);
  let rest: string[];
  if (ssh) {
    rest = ssh[1].split('/');
  } else {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
    if (scheme && !/^https?:\/\//i.test(s)) return null;
    if (scheme) s = s.slice(scheme[0].length);
    const parts = s.split('/');
    if (scheme) {
      if (!GITHUB_HOST.test(parts[0])) return null;
      rest = parts.slice(1);
    } else if (GITHUB_HOST.test(parts[0])) {
      rest = parts.slice(1);
    } else if (parts[0].includes('.')) {
      // A host-looking first segment that is not GitHub. GitHub accounts cannot
      // contain a dot, so this is never an owner.
      return null;
    } else {
      rest = parts;
    }
  }
  if (rest.length < 2) return null;
  const owner = rest[0];
  const repo = rest[1].replace(/\.git$/i, '');
  if (!validSegment(owner) || !validSegment(repo)) return null;
  return { owner, repo };
}

/**
 * Every path segment that came from stored user input is encoded by the caller before
 * it reaches here — `parseRepoRef` has already refused anything that is not a name, and
 * the encoding is the second half of that: validation says what may be sent, encoding
 * says it cannot be read as anything but one segment.
 */
/**
 * GitHub said "slow down" — not "no such repository" and not "empty". Kept distinct so no
 * caller can mistake an exhausted allowance for a repo with nothing in it.
 */
export class GithubRateLimitError extends Error {
  constructor(readonly resetAt: Date) {
    super(rateLimitMessage(resetAt));
    this.name = 'GithubRateLimitError';
  }
}

export function rateLimitMessage(resetAt: Date): string {
  const hh = String(resetAt.getUTCHours()).padStart(2, '0');
  const mm = String(resetAt.getUTCMinutes()).padStart(2, '0');
  return `GitHub rate limit — try again at ${hh}:${mm} UTC`;
}

/**
 * When the allowance is back, from the headers GitHub sends: Retry-After (seconds) wins,
 * then X-RateLimit-Reset (epoch seconds). With neither, a minute from now.
 */
function resetFrom(headers: Headers, nowMs: number): Date {
  const retry = Number(headers.get('retry-after'));
  if (headers.get('retry-after') && Number.isFinite(retry) && retry >= 0) {
    return new Date(nowMs + retry * 1000);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
  return new Date(nowMs + 60_000);
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null;
}

async function gh<T>(path: string, token: string): Promise<T> {
  return (await ghFull<T>(path, token)).data;
}

async function ghFull<T>(
  path: string,
  token: string,
): Promise<{ data: T; exhaustedUntil: Date | null }> {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
    // Every other outside call here has a timeout; these had none, and they run in front
    // of every fit check and in sync steps with an 8.5s budget inside a 30s function.
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    if (isRateLimited(res)) throw new GithubRateLimitError(resetFrom(res.headers, Date.now()));
    // The body goes to the log, not into the error: this message reaches the user through
    // the sync job and the fit check, and GitHub's JSON is not a sentence.
    console.warn(`[github] ${res.status} on ${path}:`, (await res.text().catch(() => '')).slice(0, 300));
    throw new Error(
      res.status === 404
        ? 'GitHub could not find that repository, or this account has no access to it.'
        : `GitHub answered ${res.status} while reading the repository.`,
    );
  }
  // A success that used up the last request of the window: say so, so the caller stops
  // before the next call is refused rather than after.
  const exhaustedUntil =
    res.headers.get('x-ratelimit-remaining') === '0' ? resetFrom(res.headers, Date.now()) : null;
  return { data: (await res.json()) as T, exhaustedUntil };
}

/** REQ-2.2 — the cheap gate. */
export async function latestCommitSha(
  ref: RepoRef,
  token: string,
  branch?: string,
): Promise<string> {
  const b = branch ?? (await defaultBranch(ref, token));
  const data = await gh<{ sha: string }>(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.repo,
    )}/commits/${encodeURIComponent(b)}`,
    token,
  );
  return data.sha;
}

export async function defaultBranch(ref: RepoRef, token: string): Promise<string> {
  const data = await gh<{ default_branch: string }>(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
    token,
  );
  return data.default_branch;
}

export interface RepoFile {
  path: string;
  content: string;
}

/** Files worth parsing for profile content. Keeps the AI pass off irrelevant code. */
const CONTENT_PATTERNS = [
  /(^|\/)(content|data|_data|config)\/.*\.(json|ya?ml|mdx?|ts|js)$/i,
  /(^|\/)(about|resume|cv|profile|experience|projects?|skills?|work)[^/]*\.(json|ya?ml|mdx?|tsx?|jsx?)$/i,
  // Sections the resume needs that live in their own files.
  /(^|\/)(research|publication|blog|engagement|award|honou?r|language|volunteer|interest|hobb)[^/]*\.(json|ya?ml|mdx?|tsx?|jsx?)$/i,
  /(^|\/)components?\/.*(about|resume|experience|projects?|skills?|hero|work)[^/]*\.(tsx?|jsx?)$/i,
  /(^|\/)app\/.*(about|resume|experience|projects?|skills?)[^/]*\/page\.(tsx?|jsx?)$/i,
];

const SKIP_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)public\//,
  /(^|\/)dist\//,
  /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|pdf|lock)$/i,
  // Social feeds carry no resume facts. Blog and research files DO — published
  // articles are evidence of communication and papers are evidence of research —
  // so only the raw post BODIES are skipped, while the metadata files that list
  // titles, venues and dates are kept.
  /(^|\/)linkedinPosts\./i,
  /(^|\/)testimonials?\./i,
  /(^|\/)blogs?\/[^/]+\.(tsx?|jsx?|mdx?)$/i,
  /blogContentsRegistry/i,
];

const MAX_FILES = 40;
const MAX_FILE_BYTES = 120_000;
/** Everything read, together — the corpus is sliced and sent to a model, so it is bounded. */
const MAX_TOTAL_BYTES = 1_000_000;

export interface TreeNode {
  path: string;
  type: string;
  size?: number;
  sha: string;
}

export interface Selection {
  selected: TreeNode[];
  /** Files that matched but were left out because a count or size budget ran out. */
  dropped: number;
  /** Files that matched but are too big to read at all. */
  oversize: number;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');

/**
 * Which files to read, fairly.
 *
 * It used to be the first 40 in tree order, which is alphabetical: a repository with 45
 * files under `components/` read `components/*` and never reached `content/*`, where the
 * resume data usually lives — and, before the sync learned to tell "unread" from
 * "removed", flagged all of it. Now the budget is dealt out one file per directory per
 * round, so every directory with content is represented before any one gets a second
 * file. The total size is capped as well as the count.
 */
export function selectCandidates(nodes: TreeNode[]): Selection {
  const matching = nodes
    .filter((n) => n.type === 'blob')
    .filter((n) => !SKIP_PATTERNS.some((p) => p.test(n.path)))
    .filter((n) => CONTENT_PATTERNS.some((p) => p.test(n.path)));
  const readable = matching.filter((n) => (n.size ?? 0) < MAX_FILE_BYTES);
  const oversize = matching.length - readable.length;

  const byDir = new Map<string, TreeNode[]>();
  for (const n of [...readable].sort((a, b) => a.path.localeCompare(b.path))) {
    const d = dirOf(n.path);
    byDir.set(d, [...(byDir.get(d) ?? []), n]);
  }
  const queues = [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, q]) => q);

  const selected: TreeNode[] = [];
  let bytes = 0;
  let progressed = true;
  while (selected.length < MAX_FILES && progressed) {
    progressed = false;
    for (const q of queues) {
      if (selected.length >= MAX_FILES) break;
      const n = q.shift();
      if (!n) continue;
      progressed = true;
      const size = n.size ?? 0;
      if (bytes + size > MAX_TOTAL_BYTES) continue;
      bytes += size;
      selected.push(n);
    }
  }
  return {
    selected,
    dropped: readable.length - selected.length,
    oversize,
  };
}

export interface Corpus {
  files: RepoFile[];
  /**
   * Reasons the corpus is a PARTIAL read of the repository (a blob that would not load, a
   * truncated tree, a rate limit). While this is non-empty "not found" proves nothing.
   */
  incomplete: string[];
  /** Files deliberately not read (budgets, size). Nothing may be flagged missing either. */
  unread: string[];
}

/**
 * Reads the portfolio's content files, and says how much of it it could not read.
 *
 * A rate limit stops the fetch gracefully with a partial result and a message naming the
 * time; it is never reported as an empty repository. When nothing at all could be read
 * because of it, the limit is thrown instead (`GithubRateLimitError`) so the caller fails
 * with that sentence rather than with "no content files found".
 */
export async function fetchPortfolioCorpus(
  ref: RepoRef,
  token: string,
  sha: string,
): Promise<Corpus> {
  const { data: tree, exhaustedUntil: treeExhausted } = await ghFull<{
    tree: TreeNode[];
    truncated?: boolean;
  }>(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.repo,
    )}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    token,
  );

  const incomplete: string[] = [];
  const unread: string[] = [];

  if (tree.truncated) {
    // GitHub cuts a recursive listing at ~100k entries. Files past the cut are invisible,
    // so a record living in one looks exactly like a record that was deleted.
    console.warn(`[github] tree for ${ref.owner}/${ref.repo} was truncated — sync is partial`);
    incomplete.push('GitHub returned only part of this repository’s file list');
  }

  const { selected, dropped, oversize } = selectCandidates(tree.tree ?? []);
  const unreadCount = dropped + oversize;
  if (unreadCount > 0) {
    unread.push(
      `${unreadCount} content file${unreadCount === 1 ? ' was' : 's were'} over the size or count limit and not read.`,
    );
  }

  // Fetched with bounded concurrency rather than one at a time: sequential blob
  // fetches measured ~5s for a dozen files, almost all of it waiting on the network.
  // The cap keeps us well inside GitHub's rate limits.
  const CONCURRENCY = 6;
  const files: RepoFile[] = [];
  let cursor = treeExhausted ? selected.length : 0;
  let limitedUntil: Date | null = treeExhausted;

  async function worker() {
    while (cursor < selected.length) {
      const node = selected[cursor++];
      try {
        const { data: blob, exhaustedUntil } = await ghFull<{ content: string; encoding: string }>(
          `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
            ref.repo,
          )}/git/blobs/${encodeURIComponent(node.sha)}`,
          token,
        );
        const content =
          blob.encoding === 'base64'
            ? Buffer.from(blob.content, 'base64').toString('utf8')
            : blob.content;
        files.push({ path: node.path, content });
        if (exhaustedUntil) {
          limitedUntil = exhaustedUntil;
          cursor = selected.length;
        }
      } catch (err) {
        // One unreadable file does not fail the sync, but it is counted: the corpus is
        // partial and nothing may be flagged missing on the strength of it.
        if (err instanceof GithubRateLimitError) {
          limitedUntil = err.resetAt;
          cursor = selected.length; // stop every worker: the next call would be refused too
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker),
  );

  const unreadBlobs = selected.length - files.length;
  if (limitedUntil && unreadBlobs > 0) {
    if (files.length === 0) throw new GithubRateLimitError(limitedUntil);
    incomplete.push(rateLimitMessage(limitedUntil));
  } else if (unreadBlobs > 0) {
    incomplete.push(
      `${unreadBlobs} file${unreadBlobs === 1 ? '' : 's'} could not be read from GitHub`,
    );
  }

  // Stable order regardless of which worker finished first, so the corpus (and the
  // content hashes derived from it) don't churn between syncs.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, incomplete, unread };
}

/** The files alone — for callers that do not care how complete the read was. */
export async function fetchPortfolioFiles(
  ref: RepoRef,
  token: string,
  sha: string,
): Promise<RepoFile[]> {
  return (await fetchPortfolioCorpus(ref, token, sha)).files;
}

/**
 * REQ-2.3 — live-site fallback for anything unresolvable from source.
 *
 * The URL is the user's own portfolio address, which is still user input: this used to
 * be a bare `fetch`, which would have reached `http://169.254.169.254/` and every other
 * internal address the host can see the moment it was wired up to anything. It is routed
 * through `safeFetchText`, which resolves the hostname, refuses private ranges, and
 * re-checks each redirect hop.
 */
export async function fetchLiveSite(url: string): Promise<string | null> {
  try {
    const html = await safeFetchText(url, {
      headers: { 'User-Agent': 'ResumerAI/1.0 (+profile-sync)' },
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    if (html === null) return null;
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20_000);
  } catch {
    return null;
  }
}

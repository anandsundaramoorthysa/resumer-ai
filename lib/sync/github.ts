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

export function parseRepoRef(input: string): RepoRef | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const parts = cleaned.split('/');
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!validSegment(owner) || !validSegment(repo)) return null;
  return { owner, repo };
}

/**
 * Every path segment that came from stored user input is encoded by the caller before
 * it reaches here — `parseRepoRef` has already refused anything that is not a name, and
 * the encoding is the second half of that: validation says what may be sent, encoding
 * says it cannot be read as anything but one segment.
 */
async function gh<T>(path: string, token: string): Promise<T> {
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
    // The body goes to the log, not into the error: this message reaches the user through
    // the sync job and the fit check, and GitHub's JSON is not a sentence.
    console.warn(`[github] ${res.status} on ${path}:`, (await res.text().catch(() => '')).slice(0, 300));
    throw new Error(
      res.status === 404
        ? 'GitHub could not find that repository, or this account has no access to it.'
        : `GitHub answered ${res.status} while reading the repository.`,
    );
  }
  return res.json() as Promise<T>;
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

export async function fetchPortfolioFiles(
  ref: RepoRef,
  token: string,
  sha: string,
): Promise<RepoFile[]> {
  const tree = await gh<{
    tree: Array<{ path: string; type: string; size?: number; sha: string }>;
  }>(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.repo,
    )}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    token,
  );

  const candidates = tree.tree
    .filter((n) => n.type === 'blob')
    .filter((n) => !SKIP_PATTERNS.some((p) => p.test(n.path)))
    .filter((n) => (n.size ?? 0) < MAX_FILE_BYTES)
    .filter((n) => CONTENT_PATTERNS.some((p) => p.test(n.path)))
    .slice(0, MAX_FILES);

  // Fetched with bounded concurrency rather than one at a time: sequential blob
  // fetches measured ~5s for a dozen files, almost all of it waiting on the network.
  // The cap keeps us well inside GitHub's rate limits.
  const CONCURRENCY = 6;
  const files: RepoFile[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const node = candidates[cursor++];
      try {
        const blob = await gh<{ content: string; encoding: string }>(
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
      } catch {
        // One unreadable file must not fail the whole sync.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker),
  );

  // Stable order regardless of which worker finished first, so the corpus (and the
  // content hashes derived from it) don't churn between syncs.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
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

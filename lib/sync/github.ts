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

export function parseRepoRef(input: string): RepoRef | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const parts = cleaned.split('/');
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} on ${path}: ${await res.text().catch(() => '')}`);
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
    `/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(b)}`,
    token,
  );
  return data.sha;
}

export async function defaultBranch(ref: RepoRef, token: string): Promise<string> {
  const data = await gh<{ default_branch: string }>(
    `/repos/${ref.owner}/${ref.repo}`,
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
  }>(`/repos/${ref.owner}/${ref.repo}/git/trees/${sha}?recursive=1`, token);

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
          `/repos/${ref.owner}/${ref.repo}/git/blobs/${node.sha}`,
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

/** REQ-2.3 — live-site fallback for anything unresolvable from source. */
export async function fetchLiveSite(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ResumerAI/1.0 (+profile-sync)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
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

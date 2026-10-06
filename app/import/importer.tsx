'use client';

/**
 * Old-resume importer — tasks 2.1, 2.2, 2.3.
 *
 * The extraction is driven from here, one chunk per request, for the reason set out in
 * lib/sync/stepped.ts: the whole job takes longer than any serverless function will run,
 * and stepping it turns that from a timeout into visible progress.
 *
 * Nothing is written until the confirm button is pressed. The review list is the point
 * of the feature, not a formality — an AI reading of someone's old PDF is a proposal,
 * and the profile it would land in is what every generated bullet is checked against.
 */

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { commitImportAction, reviewImportAction, type ImportActionResult } from './actions';
import type { ImportNote } from '@/lib/server/steward';

/**
 * A response body as JSON, or null when it is not JSON. A function killed at the host's
 * time limit answers with an HTML error page, and `res.json()` on that threw a SyntaxError
 * whose text was then shown to the user as the reason the import failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  if (!res.headers.get('content-type')?.includes('application/json')) return null;
  return res.json().catch(() => null);
}

interface Candidate {
  key: string;
  type: string;
  label: string;
  detail?: string;
  record: Record<string, unknown>;
}

interface RoleCandidate {
  key: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  bullets: Candidate[];
}

interface Preview {
  contact?: Record<string, string | undefined> | null;
  roles: RoleCandidate[];
  records: Candidate[];
  totalCount: number;
}

type Phase = 'choose' | 'reading' | 'review' | 'saved';

/**
 * Every reviewable type, in the order the sections are shown.
 *
 * This listed five types while the extractor produced thirteen, so a publication, award,
 * language or volunteering role came back from the server, was ticked by default, and
 * was never drawn — the user confirmed facts they could not see.
 */
const TYPE_ORDER = [
  'summary',
  'skill',
  'project',
  'education',
  'certification',
  'publication',
  'writing',
  'award',
  'achievement',
  'volunteering',
  'language',
  'interest',
] as const;

const TYPE_HEADINGS: Record<string, string> = {
  summary: 'Professional summary',
  skill: 'Skills',
  project: 'Projects',
  education: 'Education',
  certification: 'Certifications',
  publication: 'Publications',
  writing: 'Writing',
  award: 'Awards',
  achievement: 'Achievements',
  volunteering: 'Volunteering',
  language: 'Languages',
  interest: 'Interests',
};

type ImportSource = 'resume' | 'linkedin';

export function Importer() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('choose');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [useContact, setUseContact] = useState(true);
  const [result, setResult] = useState<ImportActionResult | null>(null);
  /** What the steward found about these candidates, keyed by candidate (STEWARD.md). */
  const [notes, setNotes] = useState<Record<string, ImportNote>>({});
  const [checking, setChecking] = useState(false);
  const [source, setSource] = useState<ImportSource>('resume');
  const [saving, startSaving] = useTransition();
  /**
   * What has been read so far, kept across failures. A dropped connection or a spent
   * allowance used to send the user back to the start with every parsed section thrown
   * away; now the sections that did come back stay here and only the rest are retried.
   */
  const chunksRef = useRef<string[]>([]);
  const partialsRef = useRef<Map<number, unknown>>(new Map());
  const truncatedRef = useRef(false);
  /** Work was kept after a failure and can be continued from the first screen. */
  const [resumable, setResumable] = useState(false);
  const [kept, setKept] = useState({ read: 0, total: 0 });
  /** Sections that are still unread after a run; each can be retried from the review. */
  const [unreadCount, setUnreadCount] = useState(0);
  const [retrying, setRetrying] = useState(false);
  /** Which review sections are expanded. Everything else is collapsed. */
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const begin = (file: File, from: ImportSource) => {
    setResumable(false);
    setUnreadCount(0);
    chunksRef.current = [];
    partialsRef.current = new Map();
    setError(null);
    setNotice(null);
    setResult(null);
    setSource(from);
    setFileName(file.name);
    setPhase('reading');
    setProgress({ done: 0, total: 0 });
  };

  /**
   * A LinkedIn export needs no model and no stepping — it is CSV with named columns, so
   * one request returns the whole review list. Reading it with AI would introduce a
   * paraphrase where the user's own words are already sitting in a field.
   */
  const runLinkedIn = async (file: File) => {
    begin(file, 'linkedin');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/import/linkedin', { method: 'POST', body: form });
      const data = (await readJson(res)) as
        | (Preview & { error?: string; notes?: string[]; filesRead?: string[] })
        | null;
      if (!res.ok || !data) {
        setError(data?.error ?? 'That export could not be read. Try again.');
        setPhase('choose');
        return;
      }

      const keys = new Set<string>([
        ...data.records.map((r) => r.key),
        ...data.roles.flatMap((r) => r.bullets.map((b) => b.key)),
      ]);
      setPreview(data);
      setSelected(keys);
      setUseContact(Boolean(data.contact));
      setPhase('review');

      const notes = [...(data.notes ?? [])];
      if (data.filesRead?.length) {
        notes.unshift(`Read ${data.filesRead.length} file${data.filesRead.length === 1 ? '' : 's'} from the archive.`);
      }
      setNotice(notes.length > 0 ? notes.join(' ') : null);
    } catch {
      setError('That export could not be read. Check your connection and try again.');
      setPhase('choose');
    }
  };

  const run = async (file: File) => {
    begin(file, 'resume');

    try {
      const form = new FormData();
      form.append('file', file);
      const uploadRes = await fetch('/api/import/extract', {
        method: 'POST',
        body: form,
      });
      const upload = await readJson(uploadRes);
      if (!uploadRes.ok || !upload) {
        setError(upload?.error ?? 'That file could not be read. Try again.');
        setPhase('choose');
        return;
      }

      chunksRef.current = upload.chunks ?? [];
      partialsRef.current = new Map();
      truncatedRef.current = Boolean(upload.truncated);
      await readAndAssemble(false);
    } catch {
      fail('The import stopped. Check your connection and try again.', false);
    }
  };

  /**
   * A failure keeps whatever was already read. From the first screens it returns to
   * "choose" with a way to continue; from the review it only shows the message, so the
   * list on screen is never lost.
   */
  const fail = (message: string, inReview: boolean) => {
    setError(message);
    if (inReview) return;
    setKept({ read: partialsRef.current.size, total: chunksRef.current.length });
    setResumable(chunksRef.current.length > 0);
    setPhase('choose');
  };

  /** Reads every section that has no result yet, then builds the review list. */
  const readAndAssemble = async (inReview: boolean) => {
    const chunks = chunksRef.current;
    const partials = partialsRef.current;
    setError(null);
    setProgress({ done: partials.size, total: chunks.length });

    for (let i = 0; i < chunks.length; i++) {
      if (partials.has(i)) continue;
      const res = await fetch('/api/import/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunk: chunks[i] }),
      }).catch(() => null);
      const json = res ? await readJson(res) : null;
      if (res?.status === 401 || res?.status === 429) {
        // Signed out, or today's AI allowance is spent: every later chunk would fail too.
        fail(json?.error ?? 'The extraction stopped partway through.', inReview);
        return;
      }
      // Anything else — a dropped connection, a host error page — costs this chunk only.
      if (res?.ok && json?.read) partials.set(i, json.partial);
      setProgress({ done: i + 1, total: chunks.length });
    }
    const unread = chunks.length - partials.size;

    const previewRes = await fetch('/api/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partials: [...partials.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p) }),
    });
    const data = (await readJson(previewRes)) as (Preview & { error?: string }) | null;
    if (!previewRes.ok || !data) {
      fail(data?.error ?? 'Could not assemble the results. Try again.', inReview);
      return;
    }

    const keys = [
      ...data.records.map((r) => r.key),
      ...data.roles.flatMap((r) => r.bullets.map((b) => b.key)),
    ];
    // Keys are content hashes, so a retry keeps every earlier decision and ticks only
    // what is new.
    const known = new Set([
      ...(preview?.records ?? []).map((r) => r.key),
      ...(preview?.roles ?? []).flatMap((r) => r.bullets.map((b) => b.key)),
    ]);
    setPreview(data);
    setSelected(
      new Set(keys.filter((k) => (known.has(k) ? selected.has(k) : true))),
    );
    setUseContact(inReview ? useContact : Boolean(data.contact));
    if (!inReview) {
      const firstRole = data.roles.find((r) => r.bullets.length > 0);
      const firstType = TYPE_ORDER.find((t) => data.records.some((r) => r.type === t));
      setOpened(new Set(firstRole ? ['role:' + firstRole.key] : firstType ? ['type:' + firstType] : []));
    }
    setResumable(false);
    setUnreadCount(unread);
    setPhase('review');
    void check(data);

    const notes: string[] = [];
    if (unread > 0) {
      notes.push(
        `${unread} of ${chunks.length} sections could not be read, so anything in them is missing from this list.`,
      );
    }
    if (truncatedRef.current) {
      notes.push('The file was longer than the import limit and was read up to the cap.');
    }
    if (keys.length === 0) {
      notes.push(
        'Nothing recognisable as a skill, role, project or qualification came back — the text may not be laid out as a resume.',
      );
    }
    setNotice(notes.length > 0 ? notes.join(' ') : null);
  };

  /** Continue after a failure on the first screen: only unread sections are requested. */
  const resume = async () => {
    setPhase('reading');
    setResumable(false);
    try {
      await readAndAssemble(false);
    } catch {
      fail('The import stopped. Check your connection and try again.', false);
    }
  };

  /** Retry the sections that failed, from the review, without losing the list. */
  const retryUnread = async () => {
    setRetrying(true);
    try {
      await readAndAssemble(true);
    } catch {
      fail('The retry stopped. Check your connection and try again.', true);
    } finally {
      setRetrying(false);
    }
  };

  /**
   * The steward's pass over what was extracted, after the list is on screen.
   *
   * Not before: the list is the point of the review step, and holding it back for a model
   * call would trade the thing the user asked for against advice about it. Duplicates
   * arrive ticked and are unticked when the answer comes.
   */
  const check = async (data: Preview) => {
    const candidates = [
      ...data.records.map((c) => ({ key: c.key, type: c.type, record: c.record })),
      ...data.roles.flatMap((r) => r.bullets.map((b) => ({ key: b.key, type: b.type, record: b.record }))),
    ];
    if (candidates.length === 0) return;
    setChecking(true);
    try {
      // Advice only: a failed request leaves the list as extracted.
      const found = await reviewImportAction(candidates).catch(() => ({}));
      setNotes((prev) => ({ ...prev, ...found }));
      const dupes = Object.entries(found).filter(([, n]) => n.duplicateOf).map(([k]) => k);
      if (dupes.length > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const k of dupes) next.delete(k);
          return next;
        });
        // Open every section holding a duplicate warning so it is not hidden when collapsed.
        const dupSet = new Set(dupes);
        setOpened((prev) => {
          const next = new Set(prev);
          for (const r of data.roles) if (r.bullets.some((b) => dupSet.has(b.key))) next.add('role:' + r.key);
          for (const c of data.records) if (dupSet.has(c.key)) next.add('type:' + c.type);
          return next;
        });
      }
    } finally {
      setChecking(false);
    }
  };

  /** Takes the steward's wording for one candidate, in place, before anything is saved. */
  const takeRewrite = (key: string) => {
    const note = notes[key];
    if (!note?.rewrite || !preview) return;
    const apply = (c: Candidate): Candidate =>
      c.key === key
        ? { ...c, label: note.rewrite!.field === 'text' ? note.rewrite!.to : c.label, record: { ...c.record, [note.rewrite!.field]: note.rewrite!.to } }
        : c;
    setPreview({
      ...preview,
      records: preview.records.map(apply),
      roles: preview.roles.map((r) => ({ ...r, bullets: r.bullets.map(apply) })),
    });
    setNotes({ ...notes, [key]: { ...note, rewrite: undefined } });
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setMany = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const grouped = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const r of preview?.records ?? []) {
      const list = map.get(r.type) ?? [];
      list.push(r);
      map.set(r.type, list);
    }
    return map;
  }, [preview]);

  const allKeys = useMemo(
    () => [
      ...(preview?.records ?? []).map((r) => r.key),
      ...(preview?.roles ?? []).flatMap((r) => r.bullets.map((b) => b.key)),
    ],
    [preview],
  );

  const save = () => {
    if (!preview) return;
    const payload = buildPayload(preview, selected, useContact);
    startSaving(async () => {
      const res = await commitImportAction(payload, source);
      setResult(res);
      if (res.ok) {
        setPhase('saved');
        router.refresh();
      }
    });
  };

  /* ------------------------------------------------------------- choose ---- */
  if (phase === 'choose') {
    return (
      <div>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {resumable ? (
          <div className="mb-6 border-l-4 border-brand bg-brand-tint p-4 text-ink">
            <p className="text-sm font-semibold">
              Your progress is kept: {kept.read} of {kept.total}{' '}
              sections of {fileName} were already read.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={() => void resume()} className="btn btn-primary text-sm">
                Continue where it stopped
              </button>
              <button
                type="button"
                onClick={() => {
                  setResumable(false);
                  chunksRef.current = [];
                  partialsRef.current = new Map();
                }}
                className="btn text-sm"
              >
                Discard and start over
              </button>
            </div>
          </div>
        ) : null}
        {/*
          * Side by side from `lg`, stacked below it.
          *
          * These are two alternatives, not two steps: upload a resume, or hand over a
          * LinkedIn export. Stacked in a 1152px shell the second one starts below the
          * fold on a 900px-tall laptop, so the page reads as "upload a resume" with a
          * footnote — and the LinkedIn route is the better one, because it brings job
          * descriptions across word for word. `items-start` so the shorter card keeps its
          * own height instead of stretching to match the four-step list beside it, which
          * would leave a card that is mostly empty border.
          */}
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="border-t border-line pt-4">
            <h2 className="font-display text-xl">Upload your existing resume</h2>
            <p className="mt-2 max-w-prose text-sm text-muted">
              PDF or DOCX. It is read in memory and never stored — only the facts you
              confirm on the next screen are saved, and each one is marked as coming from
              this import so you can always tell it apart from what you typed yourself.
            </p>

            <label
              htmlFor="resume-file"
              className="btn btn-primary mt-5 inline-flex cursor-pointer text-sm"
            >
              Choose a file
            </label>
            <input
              id="resume-file"
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void run(file);
                e.target.value = '';
              }}
            />

            <p className="mt-4 text-xs text-muted">
              A scanned or photographed resume has no text layer and cannot be read — if
              that is all you have, export a fresh PDF from the original document.
            </p>
          </div>

          <div className="border-t border-line pt-4">
            <h2 className="font-display text-xl">Or import your LinkedIn profile</h2>
            <p className="mt-2 max-w-prose text-sm text-muted">
              Not by scraping it. LinkedIn will hand you the same data itself, with every
              section complete rather than cut off behind &ldquo;show more&rdquo;, and
              asking them for it puts your account at no risk at all.
            </p>

            <ol className="mt-4 max-w-prose list-decimal space-y-1.5 pl-5 text-sm text-muted">
              <li>
                On LinkedIn, open{' '}
                <span className="text-ink">Settings &amp; Privacy → Data privacy → Get a copy of your data</span>.
              </li>
              <li>
                Choose <span className="text-ink">Want something in particular?</span> and tick
                Positions, Education, Skills, Certifications, Languages, Projects,
                Publications, Honors, Volunteering and Profile.
              </li>
              <li>
                Request the archive. It usually arrives by email within about ten minutes.
              </li>
              <li>Upload the .zip here, exactly as it arrived.</li>
            </ol>

            <label
              htmlFor="linkedin-file"
              className="btn mt-5 inline-flex cursor-pointer text-sm"
            >
              Choose your export
            </label>
            <input
              id="linkedin-file"
              type="file"
              accept=".zip,.csv,application/zip,text/csv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void runLinkedIn(file);
                e.target.value = '';
              }}
            />

            <p className="mt-4 max-w-prose text-xs text-muted">
              The archive is read in memory and never stored. Your job descriptions come
              across word for word — those are the accomplishments a portfolio repo cannot
              tell us, and the ones a resume is mostly made of.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ reading ---- */
  if (phase === 'reading') {
    if (source === 'linkedin') {
      return (
        <div className="border-t border-line pt-4" role="status" aria-live="polite">
          <h2 className="font-display text-xl">Reading {fileName}</h2>
          <p className="mt-2 text-sm text-muted">
            Unpacking the archive and reading each CSV. No model is involved, so this
            takes about a second.
          </p>
        </div>
      );
    }

    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="border-t border-line pt-4">
        <h2 className="font-display text-xl">Reading {fileName}</h2>
        <p className="mt-2 text-sm text-muted">
          Each section is read in its own short request — a single long one would be cut
          off by the host before it finished.
        </p>
        <div
          className="mt-5"
          role="status"
          aria-live="polite"
          aria-label={`Reading section ${progress.done} of ${progress.total}`}
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              {progress.total === 0
                ? 'Extracting text…'
                : `Section ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}
            </span>
            <span className="font-mono tabular">{pct}%</span>
          </div>
          <div
            className="progress mt-1.5"
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={progress.total || 100}
            aria-valuenow={progress.total ? progress.done : 0}
            aria-valuetext={
              progress.total ? `${progress.done} of ${progress.total} sections read` : 'Extracting text'
            }
          >
            <div className="transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- saved -- */
  if (phase === 'saved') {
    return (
      <div className="border-t border-line pt-4 text-center">
        <h2 className="font-display text-2xl">Added to your profile</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">{result?.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/profile"
            className="btn btn-primary inline-flex text-sm"
          >
            View your profile
          </Link>
          <Link
            href="/"
            className="btn inline-flex text-sm"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------- review -- */
  const selectedCount = allKeys.filter((k) => selected.has(k)).length;
  const dupCount = allKeys.filter((k) => notes[k]?.duplicateOf).length;

  return (
    <div>
      {notice ? <Banner tone="warning">{notice}</Banner> : null}
      {result && !result.ok ? <Banner tone="danger">{result.message}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {unreadCount > 0 ? (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => void retryUnread()}
            disabled={retrying}
            className="btn text-sm"
          >
            {retrying
              ? `Retrying… ${progress.done} of ${progress.total}`
              : `Retry ${unreadCount} unread section${unreadCount === 1 ? '' : 's'}`}
          </button>
          <span className="sr-only" role="status">
            {retrying ? 'Retrying unread sections' : ''}
          </span>
        </div>
      ) : null}

      <div className="border-t border-line pt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-xl">What was found in {fileName}</h2>
            <p className="mt-1 text-sm text-muted">
              Untick anything that is wrong or out of date. Nothing is saved until you
              press the button.
            </p>
            <p className="mt-1 text-sm font-semibold">
              {selectedCount} selected · {dupCount} possible duplicate{dupCount === 1 ? '' : 's'}
            </p>
            {checking ? (
              <p className="mt-1 text-xs text-muted" role="status">
                Checking these against your profile…
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                setOpened(
                  opened.size > 0
                    ? new Set()
                    : new Set([
                        ...(preview?.roles ?? []).filter((r) => r.bullets.length > 0).map((r) => 'role:' + r.key),
                        ...TYPE_ORDER.filter((t) => grouped.has(t)).map((t) => 'type:' + t),
                      ]),
                )
              }
              className="btn text-xs"
            >
              {opened.size > 0 ? 'Collapse all' : 'Expand all'}
            </button>
            <button
              type="button"
              onClick={() => setMany(allKeys, true)}
              className="btn text-xs"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setMany(allKeys, false)}
              className="btn text-xs"
            >
              Clear all
            </button>
          </div>
        </div>

        {preview?.contact ? (
          <fieldset className="mt-6 border-t border-line pt-3">
            <legend className="pr-3 text-sm font-semibold">Contact details</legend>
            <label className="flex min-h-11 items-start gap-3 py-1">
              <input
                type="checkbox"
                checked={useContact}
                onChange={(e) => setUseContact(e.target.checked)}
                className="mt-1 h-4 w-4 flex-none accent-brand"
              />
              <span className="min-w-0 text-sm">
                {[
                  preview.contact.fullName,
                  preview.contact.email,
                  preview.contact.phone,
                  preview.contact.location,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'No contact details found'}
                <span className="mt-0.5 block text-xs text-muted">
                  Only fills in fields your profile does not already have — an old resume
                  should not overwrite a current phone number.
                </span>
              </span>
            </label>
          </fieldset>
        ) : null}

        {/* A LinkedIn position with no description brings no bullets, so its group held
            only a date line and an "Untick all (0/0)" button that does nothing. The
            banner above already reports how many positions had no description; an empty
            fieldset only adds a control the user cannot use. */}
        {(preview?.roles ?? []).filter((r) => r.bullets.length > 0).map((role) => {
          const keys = role.bullets.map((b) => b.key);
          const on = keys.filter((k) => selected.has(k)).length;
          return (
            <ReviewSection
              key={role.key}
              id={`role:${role.key}`}
              opened={opened}
              setOpened={setOpened}
              title={`${role.title}${role.company ? ` — ${role.company}` : ''}`}
              meta={`${on}/${keys.length} ticked`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-xs text-muted">
                  {[role.startDate, role.endDate].filter(Boolean).join(' – ') ||
                    'dates not stated'}
                </p>
                <button
                  type="button"
                  onClick={() => setMany(keys, on !== keys.length)}
                  className="min-h-11 px-2 py-1 text-xs font-semibold text-brand-dark hover:underline"
                >
                  {on === keys.length ? 'Untick all' : 'Tick all'} ({on}/{keys.length})
                </button>
              </div>
              <ul className="mt-1">
                {role.bullets.map((b) => (
                  <CandidateRow
                    key={b.key}
                    candidate={b}
                    checked={selected.has(b.key)}
                    onToggle={() => toggle(b.key)}
                    note={notes[b.key]}
                    onUseRewrite={() => takeRewrite(b.key)}
                  />
                ))}
              </ul>
            </ReviewSection>
          );
        })}

        {TYPE_ORDER.filter((t) => grouped.has(t)).map((type) => {
          const list = grouped.get(type)!;
          const keys = list.map((c) => c.key);
          const on = keys.filter((k) => selected.has(k)).length;
          /*
           * Short entries go into columns; long ones stay a list.
           *
           * A LinkedIn export produces a Skills group of single words — "Go", "Terraform",
           * "Kubernetes" — and in the 1152px page shell each of those was a checkbox
           * followed by 1,050px of nothing, eight rows deep. The Professional summary
           * group in the same list is a full paragraph and must not be columned at all.
           *
           * So the shape is decided from the content rather than the type: a group whose
           * every entry is a short label with no second line reads as a set of tags and
           * is laid out as one. 60 characters is roughly what fits one line of a third-width
           * column here; the longest real skill in a LinkedIn export ("Distributed Systems
           * Observability and Tracing", 45) sits inside that, and an entry that does run
           * over simply wraps to a second line rather than dragging the whole group back
           * into a single column.
           *
           * The dashed rule between rows goes with it. It separates one entry from the
           * next down a single column; across three it would draw a line under every
           * item except the last of the last column, which reads as a mistake. The grid
           * gap does that job in the columned form.
           */
          const tagLike = list.every((c) => !c.detail && c.label.length <= 60);
          return (
            <ReviewSection
              key={type}
              id={`type:${type}`}
              opened={opened}
              setOpened={setOpened}
              title={TYPE_HEADINGS[type]}
              meta={`${on}/${keys.length} ticked`}
            >
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setMany(keys, on !== keys.length)}
                  className="min-h-11 px-2 py-1 text-xs font-semibold text-brand-dark hover:underline"
                >
                  {on === keys.length ? 'Untick all' : 'Tick all'} ({on}/{keys.length})
                </button>
              </div>
              <ul className={tagLike ? 'grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3' : ''}>
                {list.map((c) => (
                  <CandidateRow
                    key={c.key}
                    candidate={c}
                    checked={selected.has(c.key)}
                    onToggle={() => toggle(c.key)}
                    divided={!tagLike}
                    note={notes[c.key]}
                    onUseRewrite={() => takeRewrite(c.key)}
                  />
                ))}
              </ul>
            </ReviewSection>
          );
        })}

        {/*
          * Stuck to the bottom of the viewport while the list is on screen.
          *
          * A real resume produces around eighty candidates, and the review list ran to
          * 9,402px on a 320px phone — the only way to commit an import was to scroll
          * sixteen screens past every checkbox to reach the button, and the running count
          * of what you had ticked was only ever visible once you got there. It settles
          * into place at the end of the card, so nothing is permanently covered.
          */}
        <div className="sticky bottom-0 z-10 mt-6 flex flex-wrap items-center gap-3 border-t border-line bg-paper pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={save}
            disabled={saving || selectedCount === 0}
            className="btn btn-primary text-sm"
          >
            {saving ? (
              'Saving…'
            ) : (
              <>
                Add {selectedCount} item{selectedCount === 1 ? '' : 's'}
                {/* Dropped below `sm` so the bar stays one row: with the full label it
                    wrapped, and two rows of buttons took 133px of a 568px phone. */}
                <span className="hidden sm:inline"> to my profile</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              setPhase('choose');
            }}
            className="min-h-11 px-4 py-2.5 text-sm font-semibold text-muted hover:text-ink"
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

/** One collapsible group in the review list, with its tick count on the summary line. */
function ReviewSection({
  id,
  opened,
  setOpened,
  title,
  meta,
  children,
}: {
  id: string;
  opened: Set<string>;
  setOpened: (next: Set<string>) => void;
  title: string;
  meta: string;
  children: React.ReactNode;
}) {
  const open = opened.has(id);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now === open) return;
        const next = new Set(opened);
        if (now) next.add(id);
        else next.delete(id);
        setOpened(next);
      }}
      className="mt-5 border-t border-line pt-1"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span>
          <span aria-hidden="true" className="mr-2 font-mono text-xs">
            {open ? '▾' : '▸'}
          </span>
          {title}
        </span>
        <span className="font-mono text-xs font-normal text-muted tabular">{meta}</span>
      </summary>
      {children}
    </details>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
  note,
  onUseRewrite,
  /**
   * Whether to draw the dashed rule under the row. Off in the columned groups, where a
   * per-row underline no longer marks the end of anything — see the caller.
   */
  divided = true,
}: {
  candidate: Candidate;
  checked: boolean;
  onToggle: () => void;
  note?: ImportNote;
  onUseRewrite?: () => void;
  divided?: boolean;
}) {
  return (
    <li>
      <label
        className={`flex min-h-11 items-start gap-3 py-2 ${
          divided ? 'border-b border-line last:border-b-0' : ''
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 h-4 w-4 flex-none accent-brand"
        />
        <span className="min-w-0 text-sm">
          {candidate.label}
          {candidate.detail ? (
            <span className="mt-0.5 block text-xs text-muted">{candidate.detail}</span>
          ) : null}
          {note?.duplicateOf ? (
            <span className="mt-0.5 block text-xs text-warning">
              Already in your profile as {note.duplicateOf} — unticked
            </span>
          ) : null}
          {note?.rewrite ? (
            <span className="mt-1 block bg-brand-tint px-2 py-1.5 text-xs text-ink">
              <span className="block font-semibold">Suggested wording</span>
              <span className="mt-0.5 block">{note.rewrite.to}</span>
              <span className="mt-0.5 block text-muted">{note.rewrite.reason}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onUseRewrite?.();
                }}
                className="mt-1 min-h-11 border border-brand px-3 text-xs font-semibold text-brand-dark hover:bg-brand-tint"
              >
                Use this wording
              </button>
            </span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'danger' | 'warning';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'danger'
      ? 'bg-danger-tint text-danger'
      : 'bg-warning-tint text-warning';
  return (
    <p role="alert" className={`mb-4 px-3.5 py-2.5 text-sm ${cls}`}>
      {children}
    </p>
  );
}

/**
 * Turns the ticked boxes into the commit payload. Only selected items are sent — the
 * server re-validates and re-hashes everything, so this is the convenience half of the
 * confirmation, not the enforcement half.
 */
function buildPayload(
  preview: Preview,
  selected: Set<string>,
  useContact: boolean,
) {
  const roles = preview.roles
    .map((role) => ({
      title: role.title,
      company: role.company,
      startDate: role.startDate,
      endDate: role.endDate,
      bullets: role.bullets
        .filter((b) => selected.has(b.key))
        .map((b) => ({
          text: String(b.record.text ?? ''),
          action: String(b.record.action ?? ''),
          scale: optional(b.record.scale),
          outcome: optional(b.record.outcome),
          tags: (b.record.tags as string[]) ?? [],
        })),
    }))
    // A role is kept when the user left at least one of its bullets ticked, and also
    // when it never had any to tick: a LinkedIn position with no description is still a
    // real job, and dropping it would hide it from the profile page that exists to
    // prompt for exactly those missing accomplishments. Unticking every bullet a role
    // did have is a decision, though, and is respected.
    .filter((r, i) => r.bullets.length > 0 || preview.roles[i].bullets.length === 0);

  const records = preview.records
    .filter((c) => selected.has(c.key))
    .map((c) => {
      const { contentHash: _hash, source: _source, ...rest } = c.record;
      void _hash;
      void _source;
      return rest;
    });

  return {
    contact: useContact ? (preview.contact ?? null) : null,
    roles,
    records,
  };
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

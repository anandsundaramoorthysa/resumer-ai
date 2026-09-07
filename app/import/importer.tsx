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

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { commitImportAction, type ImportActionResult } from './actions';

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
  const [source, setSource] = useState<ImportSource>('resume');
  const [saving, startSaving] = useTransition();

  const begin = (file: File, from: ImportSource) => {
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
      const data = (await res.json()) as Preview & {
        error?: string;
        notes?: string[];
        filesRead?: string[];
      };
      if (!res.ok) {
        setError(data.error ?? 'That export could not be read.');
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
    } catch (err) {
      setError((err as Error).message);
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
      const upload = await uploadRes.json();
      if (!uploadRes.ok) {
        setError(upload.error ?? 'That file could not be read.');
        setPhase('choose');
        return;
      }

      const chunks: string[] = upload.chunks ?? [];
      setProgress({ done: 0, total: chunks.length });

      const partials: unknown[] = [];
      let unread = 0;

      for (let i = 0; i < chunks.length; i++) {
        const res = await fetch('/api/import/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chunk: chunks[i] }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? 'The extraction stopped partway through.');
          setPhase('choose');
          return;
        }
        if (json.read) partials.push(json.partial);
        else unread += 1;
        setProgress({ done: i + 1, total: chunks.length });
      }

      const previewRes = await fetch('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partials }),
      });
      const data = (await previewRes.json()) as Preview & { error?: string };
      if (!previewRes.ok) {
        setError(data.error ?? 'Could not assemble the results.');
        setPhase('choose');
        return;
      }

      const allKeys = new Set<string>([
        ...data.records.map((r) => r.key),
        ...data.roles.flatMap((r) => r.bullets.map((b) => b.key)),
      ]);
      setPreview(data);
      setSelected(allKeys);
      setUseContact(Boolean(data.contact));
      setPhase('review');

      const notes: string[] = [];
      if (unread > 0) {
        notes.push(
          `${unread} of ${chunks.length} sections could not be read, so anything in them is missing from this list.`,
        );
      }
      if (upload.truncated) {
        notes.push('The file was longer than the import limit and was read up to the cap.');
      }
      if (allKeys.size === 0) {
        notes.push(
          'Nothing recognisable as a skill, role, project or qualification came back — the text may not be laid out as a resume.',
        );
      }
      setNotice(notes.length > 0 ? notes.join(' ') : null);
    } catch (err) {
      setError((err as Error).message);
      setPhase('choose');
    }
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
        <div className="rounded-2xl border border-dashed border-line bg-surface p-6 sm:p-8">
          <h2 className="font-display text-xl">Upload your existing resume</h2>
          <p className="mt-2 max-w-prose text-sm text-muted">
            PDF or DOCX. It is read in memory and never stored — only the facts you
            confirm on the next screen are saved, and each one is marked as coming from
            this import so you can always tell it apart from what you typed yourself.
          </p>

          <label
            htmlFor="resume-file"
            className="mt-5 inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
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

        <div className="mt-5 rounded-2xl border border-dashed border-line bg-surface p-6 sm:p-8">
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
            className="mt-5 inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-5 py-2.5 text-sm font-semibold hover:bg-paper"
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
    );
  }

  /* ------------------------------------------------------------ reading ---- */
  if (phase === 'reading') {
    if (source === 'linkedin') {
      return (
        <div className="rounded-2xl border border-line bg-surface p-6" role="status" aria-live="polite">
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
      <div className="rounded-2xl border border-line bg-surface p-6">
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
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-brand transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- saved -- */
  if (phase === 'saved') {
    return (
      <div className="rounded-2xl border border-line bg-surface p-8 text-center">
        <h2 className="font-display text-2xl">Added to your profile</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">{result?.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/profile"
            className="inline-flex min-h-11 items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
          >
            View your profile
          </Link>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-5 py-2.5 text-sm font-semibold hover:bg-paper"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------- review -- */
  const selectedCount = allKeys.filter((k) => selected.has(k)).length;

  return (
    <div>
      {notice ? <Banner tone="warning">{notice}</Banner> : null}
      {result && !result.ok ? <Banner tone="danger">{result.message}</Banner> : null}

      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-xl">What was found in {fileName}</h2>
            <p className="mt-1 text-sm text-muted">
              Untick anything that is wrong or out of date. Nothing is saved until you
              press the button.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMany(allKeys, true)}
              className="min-h-11 rounded-lg border border-line px-3 py-2 text-xs font-semibold hover:bg-paper"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setMany(allKeys, false)}
              className="min-h-11 rounded-lg border border-line px-3 py-2 text-xs font-semibold hover:bg-paper"
            >
              Clear all
            </button>
          </div>
        </div>

        {preview?.contact ? (
          <fieldset className="mt-6 rounded-xl border border-line p-4">
            <legend className="px-1.5 text-sm font-semibold">Contact details</legend>
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

        {(preview?.roles ?? []).map((role) => {
          const keys = role.bullets.map((b) => b.key);
          const on = keys.filter((k) => selected.has(k)).length;
          return (
            <fieldset key={role.key} className="mt-5 rounded-xl border border-line p-4">
              <legend className="px-1.5 text-sm font-semibold">
                {role.title}
                {role.company ? ` — ${role.company}` : ''}
              </legend>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-xs text-muted">
                  {[role.startDate, role.endDate].filter(Boolean).join(' – ') ||
                    'dates not stated'}
                </p>
                <button
                  type="button"
                  onClick={() => setMany(keys, on !== keys.length)}
                  className="min-h-11 rounded px-2 py-1 text-xs font-semibold text-brand-dark hover:underline"
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
                  />
                ))}
              </ul>
            </fieldset>
          );
        })}

        {TYPE_ORDER.filter((t) => grouped.has(t)).map((type) => {
          const list = grouped.get(type)!;
          const keys = list.map((c) => c.key);
          const on = keys.filter((k) => selected.has(k)).length;
          return (
            <fieldset key={type} className="mt-5 rounded-xl border border-line p-4">
              <legend className="px-1.5 text-sm font-semibold">
                {TYPE_HEADINGS[type]}
              </legend>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setMany(keys, on !== keys.length)}
                  className="min-h-11 rounded px-2 py-1 text-xs font-semibold text-brand-dark hover:underline"
                >
                  {on === keys.length ? 'Untick all' : 'Tick all'} ({on}/{keys.length})
                </button>
              </div>
              <ul>
                {list.map((c) => (
                  <CandidateRow
                    key={c.key}
                    candidate={c}
                    checked={selected.has(c.key)}
                    onToggle={() => toggle(c.key)}
                  />
                ))}
              </ul>
            </fieldset>
          );
        })}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button
            type="button"
            onClick={save}
            disabled={saving || selectedCount === 0}
            className="min-h-11 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
          >
            {saving
              ? 'Saving…'
              : `Add ${selectedCount} item${selectedCount === 1 ? '' : 's'} to my profile`}
          </button>
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              setPhase('choose');
            }}
            className="min-h-11 rounded-lg px-4 py-2.5 text-sm font-semibold text-muted hover:text-ink"
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: Candidate;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex min-h-11 items-start gap-3 border-b border-dashed border-line py-2 last:border-b-0">
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
    <p role="alert" className={`mb-4 rounded-lg px-3.5 py-2.5 text-sm ${cls}`}>
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

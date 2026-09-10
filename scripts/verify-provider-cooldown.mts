/**
 * The provider cooldown must cross a process boundary — lib/ai/cooldowns.ts.
 *
 * WHAT THIS PROVES, AND WHY IT NEEDS TWO PROCESSES
 *
 * The cooldown used to be a module-level Map. On Netlify that memory dies with the
 * instance, so every cold invocation started with an empty map and re-learned the same
 * outage at full price. Measured in production: `gemini-flash-latest` was overloaded for
 * hours, it is first in the routing order, and every single draft paid 4-13 seconds to be
 * told "This model is currently experiencing high demand" before falling through to a
 * provider that answered in about three — out of a 20-second budget, inside a 30-second
 * function limit.
 *
 * A single-process test cannot tell the fixed code from the broken code: the in-memory
 * Map passes it too. So this benches a provider HERE, in this process, and then asks a
 * SECOND process — which has never seen the failure — which providers it would use. That
 * second process is the one that used to get it wrong.
 *
 * Writes and then deletes exactly one row, keyed by provider id. It touches no user data.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/verify-provider-cooldown.mts
 */

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cooldownSnapshot,
  flushCooldownWrites,
  loadCooldowns,
  noteBench,
} from '../lib/ai/cooldowns';
import { availableProviders, type ProviderId } from '../lib/ai/models';
import { usableProviders } from '../lib/ai/chain';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** The child prints one JSON line and exits; the parent reads it. */
if (process.env.RESUMER_COOLDOWN_CHILD === '1') {
  await runChild();
} else {
  await runParent();
}

async function runChild(): Promise<void> {
  // A cold instance: this process has never seen a provider fail. Everything it knows
  // comes from the read below.
  await loadCooldowns();
  console.log(
    JSON.stringify({
      benched: cooldownSnapshot().map((c) => ({ providerId: c.providerId, reason: c.reason })),
      usable: usableProviders().map((p) => p.id),
    }),
  );
}

async function runParent(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      'DATABASE_URL is not set. This harness proves the cooldown crosses processes, which\n' +
        'is exactly the part that needs a database — there is nothing to check without one.\n' +
        '(The chain itself degrades to in-memory; tests/cooldowns.test.mts pins that.)',
    );
    process.exit(1);
  }

  const configured = availableProviders();
  if (configured.length < 2) {
    console.error(
      `Only ${configured.length} provider(s) configured. The chain deliberately hands back\n` +
        'every provider when they are all cooling down, so a fallback cannot be observed\n' +
        'with fewer than two keys in .env.',
    );
    process.exit(1);
  }

  // The one at the front of the routing order — the one whose outage costs the most.
  const victim = configured[0].id;
  console.log(`benching ${victim} in this process (pid ${process.pid})\n`);

  await clearRow(victim);

  noteBench(victim, 'overload');
  await flushCooldownWrites();

  const child = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('tsx/cli'),
      '--tsconfig',
      join(root, 'scripts', 'tsconfig.json'),
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, RESUMER_COOLDOWN_CHILD: '1' },
    },
  );

  const failures: string[] = [];
  const check = (ok: boolean, label: string, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  try {
    const line = (child.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let seen: { benched: Array<{ providerId: string; reason: string }>; usable: string[] };
    try {
      seen = JSON.parse(line);
    } catch {
      console.error('the second process printed nothing usable:');
      console.error(child.stdout);
      console.error(child.stderr);
      process.exit(1);
    }

    console.log(`a second process, which never saw ${victim} fail:`);
    check(
      seen.benched.some((b) => b.providerId === victim && b.reason === 'overload'),
      `knows ${victim} is benched, and why`,
      JSON.stringify(seen.benched),
    );
    check(
      !seen.usable.includes(victim),
      `skips ${victim} when choosing providers`,
      `would use: ${seen.usable.join(' -> ') || '(none)'}`,
    );
    check(
      seen.usable.length > 0,
      'still has providers to fall through to',
      `${seen.usable.length} of ${configured.length}`,
    );
    check(
      seen.usable[0] === configured[1].id,
      `starts at ${configured[1].id} instead — the provider that used to be reached last`,
    );

    console.log('');
    if (failures.length > 0) {
      console.error(
        `FAILED (${failures.length}): ${failures.join('; ')}\n` +
          'The cooldown is not crossing process boundaries, so every serverless instance ' +
          'will pay for the same outage over again.',
      );
      process.exit(1);
    }
    console.log('The cooldown crosses process boundaries.');
  } finally {
    // Leave nothing behind. This row is infrastructure state, not user data, but a
    // verification script that seeds a live database and walks away is its own bug.
    await clearRow(victim);
    console.log(`\ncleaned up: no cooldown row for ${victim}`);
  }
}

/** Deletes this provider's row, if any. Uses raw SQL so the script owns nothing. */
async function clearRow(providerId: ProviderId): Promise<void> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`delete from ai_provider_cooldown where provider_id = ${providerId}`;
  } finally {
    await sql.end();
  }
}

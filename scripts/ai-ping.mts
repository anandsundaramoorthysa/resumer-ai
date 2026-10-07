/**
 * Sends a 1-token ping to every configured provider, for both model tiers, and reports
 * which model ids still exist. Run it after changing a *_MODEL variable, and now and then
 * to catch a retired model before a user does:
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig scripts/tsconfig.json scripts/ai-ping.mts
 *
 * REQUIRES real API keys in .env and spends a few tokens per provider (a handful of
 * tokens in all). It talks to each provider directly, ignoring AI_DISABLED_PROVIDERS and
 * cooldowns, so a disabled provider can still be checked. It never prints a key.
 */

import 'dotenv/config';
import { generateText } from 'ai';
import { resolveModel } from '../lib/ai/chain';
import { describeModelConfig, PROVIDER_CHAIN } from '../lib/ai/models';

async function main() {
  const config = describeModelConfig();
  let bad = 0;
  for (const p of PROVIDER_CHAIN) {
    const c = config.find((x) => x.provider === p.id)!;
    if (!c.keyConfigured) {
      console.log(`${p.label.padEnd(14)} no key — skipped`);
      continue;
    }
    for (const tier of ['standard', 'fast'] as const) {
      const m = c.models[tier];
      const started = Date.now();
      try {
        await generateText({
          model: resolveModel(p, tier),
          prompt: 'ping',
          maxOutputTokens: 1,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(15_000),
        });
        console.log(`${p.label.padEnd(14)} ${tier.padEnd(8)} ok   ${String(Date.now() - started).padStart(5)}ms  ${m.model} (${m.source})`);
      } catch (err) {
        bad++;
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 140);
        console.log(`${p.label.padEnd(14)} ${tier.padEnd(8)} FAIL ${m.model} (${m.source}) — ${msg}`);
        console.log(`${' '.repeat(14)} if the model is retired, set ${m.envVar}`);
      }
    }
  }
  process.exit(bad ? 1 : 0);
}

main();

/** Theme cycling and reading the choice back from <html data-theme> — components/theme-state.ts. */

import { suite, test, assert } from './harness.mjs';
import { nextTheme, themeFromAttribute } from '../components/theme-state';

suite('theme state', () => {
  test('cycles system, light, dark and round', () => {
    assert(nextTheme('system') === 'light', 'system -> light');
    assert(nextTheme('light') === 'dark', 'light -> dark');
    assert(nextTheme('dark') === 'system', 'dark -> system');
  });

  test('data-theme maps back to a choice; anything else is system', () => {
    assert(themeFromAttribute('light') === 'light', 'light');
    assert(themeFromAttribute('dark') === 'dark', 'dark');
    assert(themeFromAttribute(null) === 'system', 'no attribute');
    assert(themeFromAttribute('purple') === 'system', 'stale value');
  });
});

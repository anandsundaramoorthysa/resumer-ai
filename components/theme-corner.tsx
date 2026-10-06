import { cookies } from 'next/headers';
import { ThemeToggle } from '@/components/theme-toggle';
import { isThemeChoice, THEME_COOKIE, type ThemeChoice } from '@/components/theme-state';

/**
 * The theme button for signed-out pages: the credential cards, 404 and the like have no
 * header to put it in. Absolutely placed top-right of the page (it scrolls away rather than
 * floating over content); `inline` drops the positioning for use inside a header.
 */
export async function ThemeCorner({ inline = false }: { inline?: boolean }) {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  const choice: ThemeChoice = isThemeChoice(value) ? value : 'system';
  return inline ? (
    <ThemeToggle inline choice={choice} />
  ) : (
    <div className="absolute right-3 top-3 z-40">
      <ThemeToggle inline choice={choice} />
    </div>
  );
}

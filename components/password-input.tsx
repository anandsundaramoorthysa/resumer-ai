'use client';

/**
 * A password field with a show/hide button — every password input in the app uses this.
 *
 * The button is inside the field, never submits the form, and says what it will do
 * ("Show password" / "Hide password") with `aria-pressed` for its state, so it reads the
 * same to a screen reader as it looks. Details that are easy to get wrong:
 *
 *   - While the password is visible the input is `type="text"`, and a phone keyboard would
 *     happily capitalise, autocorrect and spell-check it — "Summer2024" can come back as
 *     "summer 2024". Those are switched off, whichever type the field currently has.
 *   - It goes back to hidden when the form is submitted, so a password is not left on the
 *     screen after the button that sent it.
 *   - Two fields for one new password can share one toggle (`visible`/`onVisibleChange`),
 *     so showing the first shows the second and they can be compared by eye.
 *   - Caps Lock is reported while typing, because a password typed in capitals fails with
 *     "wrong password" and nothing on screen says why.
 *
 * `autoComplete` is passed straight through — current-password and new-password are what
 * tell a password manager which kind of field this is, and changing the type does not
 * change that.
 */

import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Controlled visibility, for a pair of fields that should show and hide together. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
};

export function PasswordInput({ visible, onVisibleChange, className = '', id, ...rest }: Props) {
  const [ownVisible, setOwnVisible] = useState(false);
  const shown = visible ?? ownVisible;
  const setShown = (next: boolean) => {
    if (onVisibleChange) onVisibleChange(next);
    else setOwnVisible(next);
  };

  const [capsLock, setCapsLock] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const ref = useRef<HTMLInputElement>(null);

  // Hidden again the moment the form is sent.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const hide = () => {
      if (onVisibleChange) onVisibleChange(false);
      else setOwnVisible(false);
    };
    form.addEventListener('submit', hide);
    return () => form.removeEventListener('submit', hide);
  }, [onVisibleChange]);

  // Margins belong to the box, not the input: on the input, `mt-1` pushed the field down
  // inside its wrapper and the button — pinned to the wrapper's full height — sat 4px high.
  const classes = className.split(/\s+/).filter(Boolean);
  const isMargin = (c: string) => /^-?m[trblxy]?-/.test(c);
  const wrapperClass = classes.filter(isMargin).join(' ');
  const inputClass = classes.filter((c) => !isMargin(c)).join(' ');

  const readCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // getModifierState is missing on some synthetic events; a missing answer is "off".
    setCapsLock(Boolean(e.getModifierState?.('CapsLock')));
  };

  return (
    <>
      <span className={`relative block ${wrapperClass}`}>
        <input
          {...rest}
          id={inputId}
          ref={ref}
          type={shown ? 'text' : 'password'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            readCaps(e);
            rest.onKeyDown?.(e);
          }}
          onKeyUp={(e) => {
            readCaps(e);
            rest.onKeyUp?.(e);
          }}
          onBlur={(e) => {
            setCapsLock(false);
            rest.onBlur?.(e);
          }}
          className={`${inputClass} pr-12`}
        />
        <button
          type="button"
          onClick={() => setShown(!shown)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          aria-controls={inputId}
          title={shown ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      </span>
      {capsLock ? (
        <span role="status" className="mt-1 block text-xs text-warning">
          Caps Lock is on.
        </span>
      ) : null}
    </>
  );
}

function Eye() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.6 3.6" />
      <path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

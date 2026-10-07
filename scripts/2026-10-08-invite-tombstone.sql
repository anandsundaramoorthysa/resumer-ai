-- Invite redemptions survive account deletion as quota tombstones.
--
-- Before: invite_redemption.user_id was NOT NULL ... ON DELETE CASCADE, so deleting an
-- account removed its redemption row and the daily (IST) auto-approve cap reset: signup ->
-- approve -> delete -> repeat. After: user_id is nullable and ON DELETE SET NULL; the
-- quota counts rows by redeemed_at regardless of user_id. The UNIQUE (user_id) constraint
-- stays (Postgres allows many NULLs). Idempotent: a second run changes nothing.
-- NOT applied to any database by the repo; run it by hand after review.

ALTER TABLE "invite_redemption" ALTER COLUMN "user_id" DROP NOT NULL;

DO $$
DECLARE
  fk record;
  already boolean := false;
BEGIN
  -- Every FK on invite_redemption(user_id), whatever it was named (hand-written SQL says
  -- *_user_id_fkey, drizzle-kit says *_user_id_user_id_fk).
  FOR fk IN
    SELECT c.conname, c.confdeltype
    FROM pg_constraint c
    WHERE c.conrelid = 'public.invite_redemption'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public."user"'::regclass
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'public.invite_redemption'::regclass AND attname = 'user_id')]
  LOOP
    IF fk.confdeltype = 'n' THEN  -- already SET NULL
      already := true;
    ELSE
      EXECUTE format('ALTER TABLE "invite_redemption" DROP CONSTRAINT %I', fk.conname);
    END IF;
  END LOOP;

  IF NOT already THEN
    ALTER TABLE "invite_redemption"
      ADD CONSTRAINT "invite_redemption_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;
  END IF;
END $$;

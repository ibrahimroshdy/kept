-- Custom SQL migration file, put your code below! --
-- Step 2, task 4: the foundations the inventory tables build on (engineering spec §7.2, §7.4,
-- §7.9, §7.13; D42, D136, D168, D172, D183; plan Q1, Q15).
--   1. kept.touch_row() learns cache columns (Q1).
--   2. Search normalisation in SQL: kept.normalize(), kept.strip_prefixes(), kept.search_text().
--   3. Account scope for the account registries: visible / writable / admin account ids, and
--      whether the recovery kit has been acknowledged.
--   4. Registry history is account-level audit (Q15).
--   5. Instance admins switch currencies on and off (D168). The ISO list itself is upserted by
--      `kept migrate` (src/db/seed-reference.ts), not here.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. Row bookkeeping with cache columns (§7.9, D183, Q1). Trigger arguments, both optional and
--    comma-separated column names:
--      TG_ARGV[0]: "quiet" columns: a change to them alone bumps nothing (place_path, search_tsv);
--      TG_ARGV[1]: "sequence" columns: a change to them (and quiet ones) bumps change_seq only,
--                  so the offline snapshot sees it, but not row_version (last_seen_at).
--    Any other change bumps change_seq, row_version and updated_at, as before. Without
--    arguments every UPDATE bumps all three, exactly as 0000's version did. The function's
--    signature is unchanged, so every existing trigger keeps pointing at it.
CREATE OR REPLACE FUNCTION kept.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  book  constant text[] := ARRAY['row_version', 'updated_at', 'change_seq'];
  quiet text[] := CASE WHEN TG_NARGS > 0 THEN string_to_array(TG_ARGV[0], ',') ELSE '{}' END;
  seqc  text[] := CASE WHEN TG_NARGS > 1 THEN string_to_array(TG_ARGV[1], ',') ELSE '{}' END;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0
     AND (to_jsonb(NEW) - book - quiet - seqc) = (to_jsonb(OLD) - book - quiet - seqc) THEN
    -- Only cache columns changed (§7.9, D183): no row_version, no updated_at.
    NEW.row_version := OLD.row_version;
    NEW.updated_at  := OLD.updated_at;
    NEW.change_seq  := CASE WHEN (to_jsonb(NEW) - book - quiet) = (to_jsonb(OLD) - book - quiet)
                            THEN OLD.change_seq ELSE nextval('kept.change_seq') END;
    RETURN NEW;
  END IF;
  NEW.change_seq := nextval('kept.change_seq');
  IF TG_OP = 'UPDATE' THEN
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 2. Search normalisation (D42, D172, screens spec §8). The JavaScript twin is
--    packages/shared/src/normalize.ts; both are checked against normalize.vectors.json
--    (src/db/normalize.test.ts). Invoker and IMMUTABLE, so expression indexes can use them.
--    Steps: NFKC + lower-case; alef forms أ إ آ ٱ → ا (before unaccent, as the twin folds them
--    before decomposing, so hamza on waw and yeh survive); unaccent (Latin accents and the
--    ß æ œ ø đ ł þ spellings); Arabic marks U+064B–U+065F, the dagger alef U+0670 and tatweel
--    U+0640 dropped (not U+0660–U+0669, the Eastern Arabic digits, which the next step folds);
--    ى ی → ي, ة → ه, ک → ك; Eastern Arabic and Persian digits → 0–9; whitespace collapsed.
CREATE FUNCTION kept.normalize(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      regexp_replace(
        public.unaccent('public.unaccent'::regdictionary,
                        translate(lower(normalize(t, NFKC)), 'أإآٱ', 'اااا')),
        '[ً-ٰٟـ]', '', 'g'),
      'ىیةک٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'ييهك01234567890123456789'),
    '\s+', ' ', 'g'))
$$;
--> statement-breakpoint
-- Per word of normalised text: (و|ب|ف|ك)?ال + at least two letters loses the prefix, then لل +
-- at least two letters. A lone one-letter prefix is never stripped (Q20: ورق, بيت stay whole).
CREATE FUNCTION kept.strip_prefixes(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(regexp_replace(t, '(^|\s)(?:[وبفك])?ال(\S{2,})', '\1\2', 'g'),
                        '(^|\s)لل(\S{2,})', '\1\2', 'g')
$$;
--> statement-breakpoint
-- What a search document indexes for `t`: both forms, so recall never drops (Q20). '' for NULL.
CREATE FUNCTION kept.search_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(kept.normalize(t) || ' ' || kept.strip_prefixes(kept.normalize(t)), '')
$$;
--> statement-breakpoint
-- Both runtime roles: requests search, and the reindex job (task 10) rebuilds documents.
REVOKE EXECUTE ON FUNCTION kept.normalize(text), kept.strip_prefixes(text), kept.search_text(text)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.normalize(text), kept.strip_prefixes(text), kept.search_text(text)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 3. Account scope (§1.1, D123). The account registries (types, place kinds, brands, vendors,
--    people, tags) belong to an owner account, and a user reaches an account through the
--    locations of it they can reach: visible → read, writable → create inline (members, D11),
--    admin → manage (D123). SECURITY DEFINER like 0006's membership functions, kept_app only.
CREATE FUNCTION kept.visible_account_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT l.owner_account_id FROM public.locations l
   WHERE l.id IN (SELECT kept.visible_location_ids())
$$;
--> statement-breakpoint
CREATE FUNCTION kept.writable_account_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT l.owner_account_id FROM public.locations l
   WHERE l.id IN (SELECT kept.writable_location_ids())
$$;
--> statement-breakpoint
CREATE FUNCTION kept.admin_account_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT l.owner_account_id FROM public.locations l
   WHERE l.id IN (SELECT kept.admin_location_ids())
$$;
--> statement-breakpoint
-- The recovery-kit gate (D193, plan Q24) for any signed-in writer: whether an instance admin has
-- acknowledged the kit. A yes or no, nothing else of instance_settings.
CREATE FUNCTION kept.recovery_kit_acknowledged() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.instance_settings s
                  WHERE s.key = 'recovery_kit_acknowledged_at'
                    AND jsonb_typeof(s.value) = 'string')
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  kept.visible_account_ids(), kept.writable_account_ids(), kept.admin_account_ids(),
  kept.recovery_kit_acknowledged()
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  kept.visible_account_ids(), kept.writable_account_ids(), kept.admin_account_ids(),
  kept.recovery_kit_acknowledged()
  TO kept_app;
--> statement-breakpoint

-- 4. Registry history (Q15). Events about an account's registries are account-level rows
--    (location_id NULL, owner_account_id the registry's account). Admins of any location of the
--    account read them; anyone who may write in one of its locations writes them (members add
--    people, vendors and tags inline, D11). Every other account-level event stays the account
--    owner's own. Both policies are made again with every earlier branch unchanged (0006).
DROP POLICY app_select ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_select ON public.audit_events FOR SELECT TO kept_app
  USING (
    location_id IN (SELECT kept.visible_location_ids())
    OR (location_id IS NULL
        AND owner_account_id = (SELECT kept.current_owner_account_id()))
    OR (location_id IS NULL
        AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                     'person', 'tag'])
        AND owner_account_id IN (SELECT kept.admin_account_ids()))
  );
--> statement-breakpoint
DROP POLICY app_insert ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_insert ON public.audit_events FOR INSERT TO kept_app
  WITH CHECK (
    actor_type = 'user'
    AND actor_id = (SELECT kept.current_user_id())
    AND (
      (location_id IN (SELECT kept.visible_location_ids())
       AND (owner_account_id IS NULL
            OR owner_account_id = (SELECT l.owner_account_id FROM public.locations l
                                    WHERE l.id = audit_events.location_id)))
      OR (location_id IS NULL
          AND owner_account_id = (SELECT kept.current_owner_account_id()))
      OR (location_id IS NULL AND owner_account_id IS NULL
          AND (SELECT kept.is_instance_admin()))
      OR (location_id IS NULL
          AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                       'person', 'tag'])
          AND owner_account_id IN (SELECT kept.writable_account_ids()))
    )
  );
--> statement-breakpoint

-- 5. Currencies (D136, D168): reference rows every request reads; an instance admin enables or
--    disables one, and nothing else of the row. Names and minor units come from the seed.
CREATE POLICY app_admin_update ON public.currencies FOR UPDATE TO kept_app
  USING ((SELECT kept.is_instance_admin()))
  WITH CHECK ((SELECT kept.is_instance_admin()));
--> statement-breakpoint
GRANT UPDATE (enabled) ON public.currencies TO kept_app;

-- Custom SQL migration file, put your code below! --
-- Triggers for the tenancy schema (0003): row bookkeeping, audit partitions, the owner
-- membership invariant, and the place tree's rules (engineering spec §7.4, §7.13).
-- Functions here are trigger or maintenance functions: nobody but kept_owner executes them
-- directly, so the default EXECUTE grant to kept_app/kept_system (0000) is taken back. A
-- trigger function needs no EXECUTE grant for the role whose statement fires it. The one
-- exception is kept.ensure_audit_partitions(), kept_system's maintenance door (section 2).

-- 1. change_seq / row_version / updated_at on every mutable table (kept.touch_row, 0000).
--    test: schema.test.ts checks every table with a row_version column has this trigger.
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.location_modules
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.invites
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.instance_settings
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.sync_tombstones
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- 2. audit_events partitions (§7.13: monthly). A partition is a table of its own: queried
--    directly it would not apply audit_events' policies, and kept_owner's default privileges
--    (0000) would hand kept_app/kept_system DML on it. So every partition loses those grants
--    and gets RLS forced with only the owner policy; rows are reached through audit_events.
--    Later months are created by a maintenance job (task 24) through ensure_audit_partitions().
CREATE FUNCTION kept.create_audit_partition(month date) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  first_day date := date_trunc('month', month)::date;
  part text := 'audit_events_' || to_char(first_day, 'YYYY_MM');
BEGIN
  IF to_regclass('public.' || part) IS NOT NULL THEN
    RETURN;
  END IF;
  -- Bounds in UTC, whatever the session's TimeZone.
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
    part, first_day::text || ' 00:00:00+00',
    (first_day + interval '1 month')::date::text || ' 00:00:00+00');
  PERFORM kept.lock_partition(part);
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.lock_partition(part text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.%I FROM kept_app, kept_system', part);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', part);
  EXECUTE format(
    'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
    part);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.create_audit_partition(date), kept.lock_partition(text)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
-- The maintenance job's door (task 24): kept_system can't create tables, so this definer does it
-- for the current month and `months_ahead` more (UTC months), and nothing else. A month whose
-- rows already fell into audit_events_default can't get its partition (Postgres refuses to
-- attach a range the default already holds); that is refused here by name, so the failed job
-- says why, and task 25 raises an admin alert whenever the default partition has rows.
CREATE FUNCTION kept.ensure_audit_partitions(months_ahead integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  this_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  month date;
  created integer := 0;
BEGIN
  IF months_ahead IS NULL OR months_ahead NOT BETWEEN 0 AND 24 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 24'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR i IN 0..months_ahead LOOP
    month := (this_month + make_interval(months => i))::date;
    CONTINUE WHEN to_regclass('public.audit_events_' || to_char(month, 'YYYY_MM')) IS NOT NULL;
    IF EXISTS (
      SELECT 1 FROM public.audit_events_default d
       WHERE d.at >= (month::text || ' 00:00:00+00')::timestamptz
         AND d.at < ((month + interval '1 month')::date::text || ' 00:00:00+00')::timestamptz
    ) THEN
      RAISE EXCEPTION 'audit_events_default holds rows for %; move them out before its partition can be created',
        to_char(month, 'YYYY-MM')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_events_default_has_rows';
    END IF;
    PERFORM kept.create_audit_partition(month);
    created := created + 1;
  END LOOP;
  RETURN created;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ensure_audit_partitions(integer) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ensure_audit_partitions(integer) TO kept_system;
--> statement-breakpoint
CREATE TABLE public.audit_events_default PARTITION OF public.audit_events DEFAULT;
--> statement-breakpoint
SELECT kept.lock_partition('audit_events_default');
--> statement-breakpoint
-- This month and three more, so the job has a quarter's slack before anything lands in default.
SELECT kept.ensure_audit_partitions(3);
--> statement-breakpoint

-- Undo fields (engineering spec §7.5, D58, D150), whoever writes the row: an event is undoable
-- for at most 7 days, and an undo points at an event of the same location (or, account-level,
-- the same account) that is still undoable. Invoker: kept_app's own policies decide which events
-- `undo_of` can name, so it can't point into a location it can't see. Which actor may undo what
-- is the undo route's check, not this one.
CREATE FUNCTION kept.guard_audit_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.undoable_until IS NOT NULL
     AND (NEW.undoable_until <= now() OR NEW.undoable_until > now() + interval '7 days') THEN
    RAISE EXCEPTION 'undoable_until must fall within the next 7 days'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_events_undo_window';
  END IF;
  IF NEW.undo_of IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.audit_events e
     WHERE e.id = NEW.undo_of
       AND e.location_id IS NOT DISTINCT FROM NEW.location_id
       AND (NEW.location_id IS NOT NULL OR e.owner_account_id = NEW.owner_account_id)
       AND e.undoable_until > now()
  ) THEN
    RAISE EXCEPTION 'undo_of must name an undoable event of the same location or account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_events_undo_of';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_audit_event() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER audit_events_guard BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION kept.guard_audit_event();
--> statement-breakpoint

-- 3. Ownership consistency (§7.13): at commit, every location has exactly one `owner`
--    membership, held by the user of its owner account; a Personal location has no other
--    member (§1.2). Deferred, so ensureAccount() can insert the location and then its owner
--    membership in one transaction (§7.14). SECURITY DEFINER: the check must see every
--    membership, not the ones the caller's policies show it.
CREATE FUNCTION kept.check_location_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  locs uuid[];
  loc uuid;
  r record;
BEGIN
  IF TG_TABLE_NAME = 'locations' THEN
    locs := ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME = 'memberships' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      locs := ARRAY[OLD.location_id];
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      locs := locs || NEW.location_id;
    END IF;
  ELSE -- owner_accounts
    SELECT array_agg(l.id) INTO locs FROM public.locations l WHERE l.owner_account_id = NEW.id;
  END IF;

  FOREACH loc IN ARRAY coalesce(locs, '{}'::uuid[]) LOOP
    SELECT l.kind,
           count(m.id) AS members,
           count(m.id) FILTER (WHERE m.role = 'owner') AS owners,
           count(m.id) FILTER (WHERE m.role = 'owner' AND m.user_id = oa.user_id) AS matching
      INTO r
      FROM public.locations l
      JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
      LEFT JOIN public.memberships m ON m.location_id = l.id
     WHERE l.id = loc
     GROUP BY l.id, l.kind;
    IF NOT FOUND THEN
      CONTINUE; -- the location itself was deleted in this transaction
    END IF;
    IF r.owners <> 1 OR r.matching <> 1 THEN
      RAISE EXCEPTION 'location % must have exactly one owner membership, held by its owner account''s user', loc
        USING ERRCODE = 'check_violation', CONSTRAINT = 'locations_owner_membership';
    END IF;
    IF r.kind = 'personal' AND r.members <> 1 THEN
      RAISE EXCEPTION 'personal location % can have no member but its owner', loc
        USING ERRCODE = 'check_violation', CONSTRAINT = 'locations_personal_owner_only';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.check_location_owner() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER locations_owner_membership
  AFTER INSERT OR UPDATE OF owner_account_id, kind ON public.locations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kept.check_location_owner();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER memberships_location_owner
  AFTER INSERT OR UPDATE OF location_id, user_id, role OR DELETE ON public.memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kept.check_location_owner();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owner_accounts_location_owner
  AFTER UPDATE OF user_id ON public.owner_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kept.check_location_owner();
--> statement-breakpoint

-- 4. The place tree (§7.13, D45, D118). A place can't sit under itself or its descendants;
--    the composite foreign key already keeps a parent in the same location. Re-parenting takes
--    a per-location transaction lock, so two concurrent moves can't close a loop between them.
--    Invoker, and confined to NEW's own location: a parent elsewhere is left to the foreign key
--    to refuse, so the walk never answers a question about another tenant's tree (RLS review
--    #2; as a definer walking every location it told a caller whether an id of their choosing
--    was an ancestor of another tenant's place). Anyone allowed to write a place can read its
--    whole location, so the caller's policies don't cut the walk short.
CREATE FUNCTION kept.check_place_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM pg_advisory_xact_lock(hashtext('kept.places'), hashtext(NEW.location_id::text));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.places p WHERE p.id = NEW.parent_id AND p.location_id = NEW.location_id
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    WITH RECURSIVE up(id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT p.parent_id FROM public.places p JOIN up ON p.id = up.id
       WHERE p.location_id = NEW.location_id AND p.parent_id IS NOT NULL
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'place % can''t be moved under itself or one of its descendants', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'places_no_loop';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The Unplaced area (D118) is fixed: it can't be trashed, re-parented (also a CHECK), or turned
-- into an ordinary place, and no place becomes one after it is created.
CREATE FUNCTION kept.guard_unplaced() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.is_unplaced IS DISTINCT FROM OLD.is_unplaced
     OR (OLD.is_unplaced AND (NEW.deleted_at IS NOT NULL
                              OR NEW.parent_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'the Unplaced area can''t be trashed or re-parented'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'places_unplaced_fixed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.check_place_parent(), kept.guard_unplaced()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER places_parent BEFORE INSERT OR UPDATE OF parent_id ON public.places
  FOR EACH ROW EXECUTE FUNCTION kept.check_place_parent();
--> statement-breakpoint
CREATE TRIGGER places_unplaced BEFORE UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION kept.guard_unplaced();

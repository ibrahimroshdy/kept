-- Custom SQL migration file, put your code below! --
-- 1.0.6 housekeeping: Moving mode isn't built (1.x), so @kept/shared marks it `soon`: in no preset
-- and never effective. kept.module_on() is effectiveModules() in SQL (src/db/agenda.test.ts checks
-- the two agree), so it says the same: never on, whatever a location's switches or preset hold.
CREATE OR REPLACE FUNCTION kept.module_on(p_location uuid, p_module text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE p_module
           WHEN 'moving' THEN false
           ELSE kept.module_enabled(p_location, p_module)
                AND CASE p_module
                      WHEN 'fuel' THEN kept.module_enabled(p_location, 'vehicles')
                      ELSE true END
         END
$$;

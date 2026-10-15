-- Custom SQL migration file, put your code below! --
-- 1.x, D251: Moving mode is built, so @kept/shared no longer marks it `soon`: it is in Complete
-- and on where enabled, as long as Labels is (modules.ts `deps`). kept.module_on() is
-- effectiveModules() in SQL (src/db/agenda.test.ts checks the two agree), so 0112's "never on"
-- gives way to 0053's rule again: enabled, and Labels on too. kept.module_enabled() already has
-- 'moving' in Complete.
CREATE OR REPLACE FUNCTION kept.module_on(p_location uuid, p_module text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT kept.module_enabled(p_location, p_module)
     AND CASE p_module
           WHEN 'fuel' THEN kept.module_enabled(p_location, 'vehicles')
           WHEN 'moving' THEN kept.module_enabled(p_location, 'labels')
           ELSE true END
$$;

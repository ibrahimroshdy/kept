-- Custom SQL migration file, put your code below! --
-- Brand logos (step-4 T9; §1.3; D157, D172; Q33): row-level security for 0057's brand_logos, the
-- account-owned PNG a brand's logo is (a files row is a location's, so it couldn't hold one;
-- brands.logo_file_id, which pointed there, is gone in 0057). Read by whoever sees the account's
-- brands (visible_account_ids, as brands, 0014); set, replaced and removed by the account's
-- admins, who manage its brands. A logo is replaced by deleting and inserting it again, so its
-- `created_by` names who set the current one; only the image columns may change in place.
-- warranties/logo.ts renders the upload (PNG, JPEG, WebP, or an SVG rasterised from a buffer
-- with no external resource, per the step-4 T0 spike) and stores only the PNG.
ALTER TABLE public.brand_logos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.brand_logos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.brand_logos FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE ON public.brand_logos FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.brand_logos FOR SELECT TO kept_app
  USING (owner_account_id IN (SELECT kept.visible_account_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.brand_logos FOR INSERT TO kept_app
  WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.brand_logos FOR UPDATE TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids()))
  WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.brand_logos FOR DELETE TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
GRANT UPDATE (png, width, height, sha256, updated_at, row_version) ON public.brand_logos TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.brand_logos
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();

-- Custom SQL migration file, put your code below! --
-- Step-4 UI review L7: a lent thing returned into a container records the container
-- (loans.return_container_id, 0086), so "Returned to" names it instead of nothing. The key
-- drizzle can't declare: ON DELETE SET NULL (col), as for the return place (0051); and kept_app
-- writes it on a return and clears it on the return's undo.
ALTER TABLE public.loans ADD CONSTRAINT loans_return_container_fk
  FOREIGN KEY (location_id, return_container_id)
  REFERENCES public.things (location_id, id) ON UPDATE CASCADE
  ON DELETE SET NULL (return_container_id);
--> statement-breakpoint
CREATE INDEX loans_return_container_idx ON public.loans (return_container_id)
  WHERE return_container_id IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE (return_container_id) ON public.loans TO kept_app;

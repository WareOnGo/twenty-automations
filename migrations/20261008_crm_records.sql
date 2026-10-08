-- Additive only: do not run Prisma migrate/db push against the shared database.
CREATE TABLE public.crm_records (
  object text NOT NULL CHECK (object IN ('notes','tasks')),
  record_id text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  opportunity_ids text[] NOT NULL DEFAULT '{}',
  twenty_created_at timestamptz,
  twenty_updated_at timestamptz,
  deleted_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_polled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object, record_id)
);
-- statement-breakpoint
CREATE INDEX crm_records_object_twenty_updated_at_idx ON public.crm_records (object,twenty_updated_at);
-- statement-breakpoint
CREATE INDEX crm_records_opportunity_ids_idx ON public.crm_records USING gin (opportunity_ids);
-- statement-breakpoint
ALTER TABLE public.crm_records ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
REVOKE ALL ON public.crm_records FROM PUBLIC,anon,authenticated,service_role;
-- statement-breakpoint
COMMENT ON TABLE public.crm_records IS 'wareongo.crm-sync.v1: complete Twenty note/task REST snapshots, private source for masked analytics';

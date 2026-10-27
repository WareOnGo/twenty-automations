-- Additive, private CRM-owned state. Never alter the shared legacy reminder/task tables.
CREATE TABLE public.crm_reminder_rollout (
  id text PRIMARY KEY CHECK (id = 'assignment-beta-v1'),
  new_leads_from timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz
);
-- statement-breakpoint
CREATE TABLE public.crm_lead_reminder_state (
  opportunity_id text PRIMARY KEY,
  source_created_at timestamptz NOT NULL,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE public.crm_lead_reminder_outbox (
  id uuid PRIMARY KEY,
  opportunity_id text NOT NULL REFERENCES public.crm_lead_reminder_state(opportunity_id),
  recipient_id integer NOT NULL,
  step text NOT NULL CHECK (step IN ('owner','0','2','4','8')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','accepted','terminal','superseded')),
  message_id uuid,
  provider_state text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE INDEX crm_lead_reminder_outbox_pending_idx ON public.crm_lead_reminder_outbox(status,updated_at);
-- statement-breakpoint
ALTER TABLE public.crm_reminder_rollout ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
ALTER TABLE public.crm_lead_reminder_state ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
ALTER TABLE public.crm_lead_reminder_outbox ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
REVOKE ALL ON public.crm_reminder_rollout, public.crm_lead_reminder_state,
  public.crm_lead_reminder_outbox FROM PUBLIC,anon,authenticated,service_role;
-- statement-breakpoint
COMMENT ON TABLE public.crm_reminder_rollout IS 'wareongo.crm-reminders.v1: immutable forward-only cutoff and fenced worker lease';
-- statement-breakpoint
COMMENT ON TABLE public.crm_lead_reminder_state IS 'wareongo.crm-reminders.v1: observed assignment episodes and completion, private';
-- statement-breakpoint
COMMENT ON TABLE public.crm_lead_reminder_outbox IS 'wareongo.crm-reminders.v1: frozen notification intents and delivery outcomes, private';

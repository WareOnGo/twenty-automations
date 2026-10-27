-- Disposable test DB prerequisites, matching the CRM mirror models. This file
-- is never a production migration. Reminder tables use the actual migration.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE "VerifiedNumber" (
  id serial PRIMARY KEY, phone_number text NOT NULL UNIQUE, name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(),
  twenty_user_id text UNIQUE, email text UNIQUE, "empID" text UNIQUE,
  role text NOT NULL DEFAULT 'EMPLOYEE', "adminAccess" boolean NOT NULL DEFAULT false,
  "callDashboardAccess" boolean NOT NULL DEFAULT false, "dashboardAccess" boolean NOT NULL DEFAULT false,
  "reviewerAccess" boolean NOT NULL DEFAULT false
);
CREATE TABLE opportunities (
  opportunity_id text PRIMARY KEY, data jsonb NOT NULL, stage text, assignee_email text,
  name text, priority text, city text, company_name text, assigned_to jsonb, owner_id text,
  last_contacted timestamptz, next_follow_up timestamptz,
  twenty_created_at timestamptz, twenty_updated_at timestamptz, deleted_at timestamptz,
  last_meaningful_update_at timestamptz, last_meaningful_update_kind text, last_meaningful_update_by text,
  last_note_at timestamptz, last_note_text text, last_task_at timestamptz, stage_entered_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_polled_at timestamptz, closure_sent_at timestamptz
);
CREATE TABLE sync_checkpoints (
  object text PRIMARY KEY, last_updated_at timestamptz, last_run_at timestamptz,
  last_run_status text, last_error text
);
CREATE TABLE stage_transitions (
  id bigserial PRIMARY KEY, opportunity_id text NOT NULL, from_stage text, to_stage text NOT NULL,
  changed_at timestamptz NOT NULL, detected_at timestamptz NOT NULL DEFAULT now()
);

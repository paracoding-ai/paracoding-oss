-- ops/db/schema.sql -- [V21-SCHEMA-V1] structure of the fleet database for a fresh install.
-- Generated from a live install with pg_dump --schema-only (no data, no owners, no grants).
-- Covers schemas: fleet, oa, picket, public. Operator-only schemas (vrp, msgraph_authz) are excluded.
-- Apply as the database owner: psql -v ON_ERROR_STOP=1 -d fleet -f schema.sql

--
-- PostgreSQL database dump
--

\restrict d3iPLQvuSEzqqrlkf78QNrrBFK1Lcvv7Qt02UDcKDBLRAYExoL25UXb6MJ3r20N

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: fleet; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS fleet;


--
-- Name: oa; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS oa;


--
-- Name: picket; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS picket;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: laws_md(); Type: FUNCTION; Schema: fleet; Owner: -
--

CREATE FUNCTION fleet.laws_md() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE(string_agg(body, '' ORDER BY ord), '') FROM fleet.laws
$$;


SET default_tablespace = '';


--
-- Name: docs; Type: TABLE; Schema: fleet; Owner: -
--

CREATE TABLE fleet.docs (
    name text NOT NULL,
    body text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: laws; Type: TABLE; Schema: fleet; Owner: -
--

CREATE TABLE fleet.laws (
    ord integer NOT NULL,
    num text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: backups; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.backups (
    id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scope text NOT NULL,
    status text NOT NULL,
    object text,
    bucket text,
    size_bytes bigint,
    sha256 text,
    manifest jsonb,
    error text,
    created_by text,
    finished_at timestamp with time zone
);


--
-- Name: chat_history; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.chat_history (
    id text NOT NULL,
    agent_id text,
    role text,
    text text,
    tags jsonb,
    session text,
    provider text,
    model text,
    effort text,
    tool_model text,
    tools_run integer,
    steps jsonb,
    ts timestamp with time zone,
    expire_at timestamp with time zone,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: clients; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.clients (
    client_id text NOT NULL,
    redirect_uris jsonb DEFAULT '[]'::jsonb NOT NULL,
    client_name text,
    token_endpoint_auth_method text DEFAULT 'none'::text,
    created_ms bigint
);


--
-- Name: codes; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.codes (
    code text NOT NULL,
    client_id text,
    redirect_uri text,
    code_challenge text,
    email text,
    role text,
    via text,
    exp_ms bigint
);


--
-- Name: journal; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.journal (
    id bigint NOT NULL,
    doc_id text,
    agent_id text,
    strain text,
    action text,
    message text,
    severity text,
    role text,
    parent text,
    detail text,
    job_id text,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    at_ts timestamp with time zone
);


--
-- Name: journal_id_seq; Type: SEQUENCE; Schema: oa; Owner: -
--

ALTER TABLE oa.journal ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME oa.journal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: kv; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.kv (
    coll text NOT NULL,
    id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mem_entities; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.mem_entities (
    id text NOT NULL,
    scope text,
    name text,
    entity_type text,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    obs_active integer DEFAULT 0 NOT NULL,
    status text,
    search_text text,
    embedding jsonb
);


--
-- Name: mem_observations; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.mem_observations (
    id text NOT NULL,
    entity_id text NOT NULL,
    text text,
    confidence text,
    evidence jsonb,
    author text,
    session text,
    created_at timestamp with time zone,
    status text,
    supersedes text,
    superseded_by text,
    embedding jsonb
);


--
-- Name: mem_relations; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.mem_relations (
    id text NOT NULL,
    scope text,
    from_name text,
    to_name text,
    relation_type text,
    created_by text,
    created_at timestamp with time zone,
    status text
);


--
-- Name: rate_limits; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.rate_limits (
    col text NOT NULL,
    id text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    reset_ms bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: refresh; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.refresh (
    token_hash text NOT NULL,
    role text,
    email text,
    client_id text,
    issued_at_ms bigint,
    exp_ms bigint,
    access_hash text,
    revoked boolean DEFAULT false NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by text,
    rotated_at_ms bigint,
    rotate_salt text,
    next_hash text,
    rt_chain text,
    prev_hash text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: strains; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.strains (
    role text NOT NULL,
    display_name text,
    status text,
    pasteable boolean,
    hidden boolean,
    tool_classes jsonb,
    created_by text,
    created_at timestamp with time zone,
    owner_email text,
    shared_with jsonb DEFAULT '[]'::jsonb NOT NULL,
    parent text,
    mode text,
    retired_by text,
    retired_at timestamp with time zone,
    sa_email text,
    oauth_client_id text,
    oauth_email text,
    delegating boolean,
    user_token_aud text,
    user_email text,
    flags_set_by text,
    flags_set_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: token_usage; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.token_usage (
    id text NOT NULL,
    agent text,
    model text,
    source text,
    input_tokens bigint DEFAULT 0,
    output_tokens bigint DEFAULT 0,
    cache_creation_input_tokens bigint DEFAULT 0,
    cache_read_input_tokens bigint DEFAULT 0,
    ts timestamp with time zone,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: token_usage_gaps; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.token_usage_gaps (
    id text NOT NULL,
    agent text,
    model text,
    source text,
    reason text,
    saw text,
    ts timestamp with time zone
);


--
-- Name: tokens; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.tokens (
    token_hash text NOT NULL,
    role text,
    email text,
    client_id text,
    exp_ms bigint,
    refresh_hash text,
    revoked boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_items; Type: TABLE; Schema: oa; Owner: -
--

CREATE TABLE oa.work_items (
    id text NOT NULL,
    title text,
    assigned_role text,
    status text,
    payload jsonb,
    summary text,
    evidence jsonb,
    created_by text,
    created_at timestamp with time zone,
    source text,
    substrate text,
    claimed_by text,
    claimed_at timestamp with time zone,
    completed_by text,
    completed_at timestamp with time zone,
    finished_at timestamp with time zone,
    completion_evidence jsonb,
    result_note text,
    cancelled_by text,
    cancelled_at timestamp with time zone,
    cancel_note text,
    updated_at timestamp with time zone,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: bans; Type: TABLE; Schema: picket; Owner: -
--

CREATE TABLE picket.bans (
    cid text NOT NULL,
    until double precision NOT NULL,
    permanent boolean DEFAULT false NOT NULL,
    ban_count integer DEFAULT 0 NOT NULL,
    reason text,
    updated timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ds_hunt_findings_wronglane; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ds_hunt_findings_wronglane (
    finding_id text,
    repo text,
    title text,
    vein text,
    program text,
    severity text,
    status text,
    verdict text,
    file_path text,
    line integer,
    pinned_sha text,
    chain text,
    precondition text,
    poc text,
    source_quote text,
    source_symbols text,
    source_proof text,
    found_by text,
    consensus text,
    llm_verdicts jsonb,
    raw jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.findings (
    finding_id text NOT NULL,
    repo text NOT NULL,
    title text,
    vein text,
    program text,
    severity text,
    status text DEFAULT 'banked'::text,
    verdict text,
    file_path text,
    line integer,
    pinned_sha text,
    chain text,
    precondition text,
    poc text,
    source_quote text,
    source_symbols text,
    source_proof text,
    found_by text DEFAULT 'flowhood-deepseek'::text,
    consensus text,
    llm_verdicts jsonb,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: fs_docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fs_docs (
    path text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: docs docs_pkey; Type: CONSTRAINT; Schema: fleet; Owner: -
--

ALTER TABLE ONLY fleet.docs
    ADD CONSTRAINT docs_pkey PRIMARY KEY (name);


--
-- Name: laws laws_pkey; Type: CONSTRAINT; Schema: fleet; Owner: -
--

ALTER TABLE ONLY fleet.laws
    ADD CONSTRAINT laws_pkey PRIMARY KEY (num);


--
-- Name: backups backups_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.backups
    ADD CONSTRAINT backups_pkey PRIMARY KEY (id);


--
-- Name: chat_history chat_history_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.chat_history
    ADD CONSTRAINT chat_history_pkey PRIMARY KEY (id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (client_id);


--
-- Name: codes codes_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.codes
    ADD CONSTRAINT codes_pkey PRIMARY KEY (code);


--
-- Name: journal journal_doc_id_key; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.journal
    ADD CONSTRAINT journal_doc_id_key UNIQUE (doc_id);


--
-- Name: journal journal_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.journal
    ADD CONSTRAINT journal_pkey PRIMARY KEY (id);


--
-- Name: kv kv_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.kv
    ADD CONSTRAINT kv_pkey PRIMARY KEY (coll, id);


--
-- Name: mem_entities mem_entities_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.mem_entities
    ADD CONSTRAINT mem_entities_pkey PRIMARY KEY (id);


--
-- Name: mem_observations mem_observations_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.mem_observations
    ADD CONSTRAINT mem_observations_pkey PRIMARY KEY (id);


--
-- Name: mem_relations mem_relations_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.mem_relations
    ADD CONSTRAINT mem_relations_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (col, id);


--
-- Name: refresh refresh_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.refresh
    ADD CONSTRAINT refresh_pkey PRIMARY KEY (token_hash);


--
-- Name: strains strains_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.strains
    ADD CONSTRAINT strains_pkey PRIMARY KEY (role);


--
-- Name: token_usage_gaps token_usage_gaps_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.token_usage_gaps
    ADD CONSTRAINT token_usage_gaps_pkey PRIMARY KEY (id);


--
-- Name: token_usage token_usage_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.token_usage
    ADD CONSTRAINT token_usage_pkey PRIMARY KEY (id);


--
-- Name: tokens tokens_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: work_items work_items_pkey; Type: CONSTRAINT; Schema: oa; Owner: -
--

ALTER TABLE ONLY oa.work_items
    ADD CONSTRAINT work_items_pkey PRIMARY KEY (id);


--
-- Name: bans bans_pkey; Type: CONSTRAINT; Schema: picket; Owner: -
--

ALTER TABLE ONLY picket.bans
    ADD CONSTRAINT bans_pkey PRIMARY KEY (cid);


--
-- Name: findings findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_pkey PRIMARY KEY (finding_id);


--
-- Name: fs_docs fs_docs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fs_docs
    ADD CONSTRAINT fs_docs_pkey PRIMARY KEY (path);


--
-- Name: ch_agent_ts_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX ch_agent_ts_idx ON oa.chat_history USING btree (agent_id, ts DESC);


--
-- Name: journal_action_ts_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX journal_action_ts_idx ON oa.journal USING btree (action, ts DESC);


--
-- Name: journal_agent_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX journal_agent_idx ON oa.journal USING btree (agent_id);


--
-- Name: journal_strain_ts_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX journal_strain_ts_idx ON oa.journal USING btree (COALESCE(strain, agent_id), ts DESC);


--
-- Name: journal_ts_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX journal_ts_idx ON oa.journal USING btree (ts DESC);


--
-- Name: kv_role_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX kv_role_idx ON oa.kv USING btree (coll, ((data ->> 'role'::text)));


--
-- Name: kv_status_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX kv_status_idx ON oa.kv USING btree (coll, ((data ->> 'status'::text)));


--
-- Name: kv_to_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX kv_to_idx ON oa.kv USING btree (coll, ((data ->> 'to'::text)));


--
-- Name: mement_scope_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX mement_scope_idx ON oa.mem_entities USING btree (scope);


--
-- Name: mement_scope_type_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX mement_scope_type_idx ON oa.mem_entities USING btree (scope, entity_type);


--
-- Name: memobs_entity_status_created_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX memobs_entity_status_created_idx ON oa.mem_observations USING btree (entity_id, status, created_at DESC);


--
-- Name: memrel_scope_from_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX memrel_scope_from_idx ON oa.mem_relations USING btree (scope, from_name);


--
-- Name: memrel_scope_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX memrel_scope_idx ON oa.mem_relations USING btree (scope);


--
-- Name: memrel_scope_to_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX memrel_scope_to_idx ON oa.mem_relations USING btree (scope, to_name);


--
-- Name: oa_backups_created_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX oa_backups_created_idx ON oa.backups USING btree (created_at DESC);


--
-- Name: refresh_client_email_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX refresh_client_email_idx ON oa.refresh USING btree (client_id, email);


--
-- Name: refresh_rt_chain_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX refresh_rt_chain_idx ON oa.refresh USING btree (rt_chain);


--
-- Name: strains_oauth_client_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX strains_oauth_client_idx ON oa.strains USING btree (oauth_client_id) WHERE (oauth_client_id IS NOT NULL);


--
-- Name: strains_sa_email_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX strains_sa_email_idx ON oa.strains USING btree (sa_email) WHERE (sa_email IS NOT NULL);


--
-- Name: strains_status_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX strains_status_idx ON oa.strains USING btree (status);


--
-- Name: strains_user_email_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX strains_user_email_idx ON oa.strains USING btree (user_email) WHERE (user_email IS NOT NULL);


--
-- Name: token_usage_ts_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX token_usage_ts_idx ON oa.token_usage USING btree (ts);


--
-- Name: tokens_client_email_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX tokens_client_email_idx ON oa.tokens USING btree (client_id, email);


--
-- Name: wi_created_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX wi_created_idx ON oa.work_items USING btree (created_at);


--
-- Name: wi_role_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX wi_role_idx ON oa.work_items USING btree (assigned_role);


--
-- Name: wi_status_idx; Type: INDEX; Schema: oa; Owner: -
--

CREATE INDEX wi_status_idx ON oa.work_items USING btree (status);


--
-- Name: fs_docs_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fs_docs_expires ON public.fs_docs USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- PostgreSQL database dump complete
--

\unrestrict d3iPLQvuSEzqqrlkf78QNrrBFK1Lcvv7Qt02UDcKDBLRAYExoL25UXb6MJ3r20N


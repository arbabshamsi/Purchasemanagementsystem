-- pms_rpc.sql
-- The SECURITY DEFINER RPCs the app uses in production (Supabase client mode).
-- All database access from src/db.js flows through these. Committed here so the
-- trusted query path is auditable in version control; they are provisioned on
-- the Supabase project (public schema) and EXECUTE is granted to service_role.
--
-- Binding: pms_bind walks the query and replaces each $n with the quote_literal
-- of params[n-1] (JSON null -> SQL NULL). It reads the FULL digit run after '$'
-- (regexp ^[0-9]+), so multi-digit placeholders ($10, $100, ...) bind correctly,
-- and every value is quoted via quote_literal, so interpolation is injection-safe.

CREATE OR REPLACE FUNCTION public.pms_bind(query text, params jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
declare
  result text := '';
  rest text := query;
  pos int;
  numstr text;
  idx int;
  el jsonb;
begin
  if params is null then params := '[]'::jsonb; end if;
  loop
    pos := position('$' in rest);
    if pos = 0 then
      result := result || rest;
      exit;
    end if;
    result := result || substr(rest, 1, pos - 1);
    rest := substr(rest, pos + 1);
    numstr := (regexp_match(rest, '^[0-9]+'))[1];
    if numstr is null then
      result := result || '$';
    else
      idx := numstr::int;
      rest := substr(rest, length(numstr) + 1);
      el := params -> (idx - 1);
      if el is null or jsonb_typeof(el) = 'null' then
        result := result || 'NULL';
      else
        result := result || quote_literal(params ->> (idx - 1));
      end if;
    end if;
  end loop;
  return result;
end;
$function$;

-- Row-returning queries: returns a JSON array of row objects.
CREATE OR REPLACE FUNCTION public.pms_exec_rows(query text, params jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pms', 'public'
AS $function$
declare
  bound text := public.pms_bind(query, params);
  rec record;
  out jsonb := '[]'::jsonb;
begin
  for rec in execute bound loop
    out := out || to_jsonb(rec);
  end loop;
  return out;
end;
$function$;

-- Non-returning statements (INSERT/UPDATE/DELETE): returns affected row count.
CREATE OR REPLACE FUNCTION public.pms_exec_run(query text, params jsonb DEFAULT '[]'::jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pms', 'public'
AS $function$
declare
  bound text := public.pms_bind(query, params);
  cnt int;
begin
  execute bound;
  get diagnostics cnt = row_count;
  return cnt;
end;
$function$;

-- Atomic multi-statement runner: executes an ordered array of { "q": sql,
-- "p": [params] } inside ONE transaction (the function body). Any statement that
-- raises aborts the whole call, so a mid-sequence failure rolls everything back.
-- Used by db.js runTx() for the requisition workflow writes.
CREATE OR REPLACE FUNCTION public.pms_exec_tx(stmts jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pms', 'public'
AS $function$
declare
  stmt jsonb;
  bound text;
  total int := 0;
  cnt int;
begin
  if stmts is null then return 0; end if;
  for stmt in select * from jsonb_array_elements(stmts) loop
    bound := public.pms_bind(stmt->>'q', coalesce(stmt->'p', '[]'::jsonb));
    execute bound;
    get diagnostics cnt = row_count;
    total := total + cnt;
  end loop;
  return total;
end;
$function$;

-- Only the service role (used by the server) may call these.
REVOKE ALL ON FUNCTION public.pms_exec_rows(text, jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.pms_exec_run(text, jsonb)  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.pms_exec_tx(jsonb)         FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pms_exec_rows(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pms_exec_run(text, jsonb)  TO service_role;
GRANT EXECUTE ON FUNCTION public.pms_exec_tx(jsonb)         TO service_role;

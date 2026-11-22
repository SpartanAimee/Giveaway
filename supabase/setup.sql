-- FFY Web Giveaway database
-- Run this once in Supabase > SQL Editor > New query > Run.
-- Running it again is safe: it only adds what's missing and updates the functions.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- Tables ----------

create table if not exists wg_config (
  id int primary key default 1 check (id = 1),
  channel_id text,
  channel_login text,
  channel_name text,
  channel_image text,
  access_token text,
  refresh_token text,
  token_expires timestamptz,
  scopes text[] not null default '{}',
  oauth_state text,
  oauth_back text,
  overlay_key text not null default replace(gen_random_uuid()::text, '-', ''),
  cron_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  overlay_test timestamptz,
  page jsonb not null default '{}'::jsonb,
  last_award timestamptz,
  last_award_count int,
  updated_at timestamptz not null default now()
);
insert into wg_config (id) values (1) on conflict do nothing;

create table if not exists wg_viewers (
  user_id text primary key,
  login text not null,
  display_name text,
  points bigint not null default 0 check (points >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists wg_viewers_login on wg_viewers (login);

create table if not exists wg_giveaways (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  prize_image text,
  ticket_cost int not null default 0 check (ticket_cost >= 0),
  max_tickets int not null default 1 check (max_tickets >= 0),
  draw_at timestamptz,
  status text not null default 'open' check (status in ('open', 'drawn', 'cancelled')),
  winner_id text,
  winner_name text,
  winner_tickets int,
  total_tickets int,
  past_winners text[] not null default '{}',
  created_at timestamptz not null default now(),
  drawn_at timestamptz
);
create index if not exists wg_giveaways_created on wg_giveaways (created_at desc);

create table if not exists wg_entries (
  giveaway_id uuid not null references wg_giveaways (id) on delete cascade,
  user_id text not null,
  login text not null,
  display_name text,
  tickets int not null default 0,
  spent bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (giveaway_id, user_id)
);

-- ---------- Streamer.bot link (FFY_Points) ----------
-- When points come from Streamer.bot, FFY_Points sends its balances here every few minutes.
-- Anything the website changes (tickets bought, refunds, points given) waits in wg_ledger until
-- Streamer.bot has applied it, so both sides always end up with the same balance.

alter table wg_config add column if not exists sync_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
alter table wg_config add column if not exists last_sync timestamptz;
alter table wg_config add column if not exists sb_info jsonb not null default '{}'::jsonb;
alter table wg_giveaways add column if not exists points_source text not null default 'builtin';

create table if not exists wg_sb_points (
  login text primary key,
  display_name text,
  points bigint not null default 0 check (points >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists wg_ledger (
  id bigint generated always as identity primary key,
  login text not null,
  delta bigint not null,
  reason text,
  created_at timestamptz not null default now(),
  applied boolean not null default false
);
create index if not exists wg_ledger_pending on wg_ledger (login) where not applied;

alter table wg_sb_points enable row level security;
alter table wg_ledger enable row level security;

-- Nobody can read or change these from a browser. Only the web-giveaway function can (it uses the service role key).
alter table wg_config enable row level security;
alter table wg_viewers enable row level security;
alter table wg_giveaways enable row level security;
alter table wg_entries enable row level security;

-- ---------- Images ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('web-giveaway', 'web-giveaway', true, 3145728, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

-- ---------- Buying tickets ----------
-- Done in one step inside the database, so two clicks at once can't spend the same points twice.

create or replace function wg_buy(p_giveaway uuid, p_user text, p_login text, p_qty int, p_max boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g wg_giveaways;
  pts bigint;
  have int;
  room int;
  can int;
  n int;
  dname text;
begin
  select * into g from wg_giveaways where id = p_giveaway for share;
  if not found or g.status <> 'open' or (g.draw_at is not null and now() >= g.draw_at) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;

  if g.points_source = 'streamerbot' then
    insert into wg_sb_points (login) values (p_login) on conflict (login) do nothing;
    select points, display_name into pts, dname from wg_sb_points where login = p_login for update;
  else
    insert into wg_viewers (user_id, login) values (p_user, p_login)
    on conflict (user_id) do update set login = excluded.login;
    select points, display_name into pts, dname from wg_viewers where user_id = p_user for update;
  end if;

  select coalesce(sum(tickets), 0) into have from wg_entries where giveaway_id = p_giveaway and user_id = p_user;
  room := case when g.max_tickets = 0 then 1000000 else g.max_tickets - have end;
  if room <= 0 then
    return jsonb_build_object('ok', false, 'error', 'max', 'tickets', have, 'points', pts);
  end if;

  can := case when g.ticket_cost = 0 then room else least(room, (pts / g.ticket_cost)::int) end;
  n := case when p_max then can else greatest(coalesce(p_qty, 1), 1) end;

  if n > room then
    return jsonb_build_object('ok', false, 'error', 'max', 'room', room, 'tickets', have, 'points', pts);
  end if;
  if n < 1 or n > can then
    return jsonb_build_object('ok', false, 'error', 'points', 'cost', g.ticket_cost, 'tickets', have, 'points', pts);
  end if;

  if g.points_source = 'streamerbot' then
    update wg_sb_points set points = points - n * g.ticket_cost, updated_at = now()
    where login = p_login returning points into pts;
    if n * g.ticket_cost > 0 then
      insert into wg_ledger (login, delta, reason) values (p_login, -(n * g.ticket_cost), 'tickets');
    end if;
  else
    update wg_viewers set points = points - n * g.ticket_cost, updated_at = now()
    where user_id = p_user returning points into pts;
  end if;

  insert into wg_entries (giveaway_id, user_id, login, display_name, tickets, spent)
  values (p_giveaway, p_user, p_login, dname, n, n * g.ticket_cost)
  on conflict (giveaway_id, user_id) do update set
    tickets = wg_entries.tickets + excluded.tickets,
    spent = wg_entries.spent + excluded.spent,
    login = excluded.login,
    display_name = coalesce(excluded.display_name, wg_entries.display_name),
    updated_at = now();

  return jsonb_build_object('ok', true, 'bought', n, 'tickets', have + n, 'points', pts, 'first', have = 0, 'cost', n * g.ticket_cost);
end $$;

-- ---------- Earning points ----------
-- p_rows: [{"id": "123", "login": "name", "name": "Name", "sub": true}, ...]

create or replace function wg_award(p_rows jsonb, p_amount int, p_sub_mult numeric)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into wg_viewers (user_id, login, display_name, points)
  select r.id, r.login, r.name, round(p_amount * case when coalesce(r.sub, false) then p_sub_mult else 1 end)::bigint
  from jsonb_to_recordset(p_rows) as r (id text, login text, name text, sub boolean)
  on conflict (user_id) do update set
    points = wg_viewers.points + excluded.points,
    login = excluded.login,
    display_name = coalesce(excluded.display_name, wg_viewers.display_name),
    updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Give or take points from one viewer (never below 0)
create or replace function wg_give(p_user text, p_login text, p_name text, p_amount bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare pts bigint;
begin
  insert into wg_viewers (user_id, login, display_name, points) values (p_user, p_login, p_name, greatest(p_amount, 0))
  on conflict (user_id) do update set
    points = greatest(wg_viewers.points + p_amount, 0),
    login = excluded.login,
    display_name = coalesce(excluded.display_name, wg_viewers.display_name),
    updated_at = now()
  returning points into pts;
  return pts;
end $$;

-- ---------- Drawing ----------
-- Each ticket is one chance. Past winners of this giveaway are skipped when drawing again.

create or replace function wg_draw(p_giveaway uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g wg_giveaways;
  skip text[];
  tot int;
  pick int;
  w record;
begin
  select * into g from wg_giveaways where id = p_giveaway for update;
  if not found or g.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'not-found');
  end if;

  skip := g.past_winners;
  if g.winner_id is not null then skip := array_append(skip, g.winner_id); end if;

  select coalesce(sum(tickets), 0) into tot from wg_entries
  where giveaway_id = p_giveaway and tickets > 0 and not (user_id = any (skip));
  if tot = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  pick := floor(random() * tot)::int;
  select user_id, login, coalesce(display_name, login) as name, tickets into w
  from (
    select user_id, login, display_name, tickets, sum(tickets) over (order by user_id) as cum
    from wg_entries
    where giveaway_id = p_giveaway and tickets > 0 and not (user_id = any (skip))
  ) e
  where cum > pick
  order by cum
  limit 1;

  -- The chance shown is out of every ticket in the giveaway
  select coalesce(sum(tickets), 0) into tot from wg_entries where giveaway_id = p_giveaway;

  update wg_giveaways set status = 'drawn', winner_id = w.user_id, winner_name = w.name,
    winner_tickets = w.tickets, total_tickets = tot, past_winners = skip, drawn_at = now()
  where id = p_giveaway;

  return jsonb_build_object('ok', true, 'winner', w.name, 'login', w.login, 'tickets', w.tickets, 'total', tot);
end $$;

-- Cancel and give everyone their points back
create or replace function wg_cancel(p_giveaway uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g wg_giveaways; n int;
begin
  select * into g from wg_giveaways where id = p_giveaway for update;
  if not found or g.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'not-open');
  end if;
  if g.points_source = 'streamerbot' then
    update wg_sb_points s set points = s.points + e.spent, updated_at = now()
    from wg_entries e
    where e.giveaway_id = p_giveaway and e.login = s.login and e.spent > 0;
    insert into wg_ledger (login, delta, reason)
    select login, spent, 'refund' from wg_entries where giveaway_id = p_giveaway and spent > 0;
    get diagnostics n = row_count;
  else
    update wg_viewers v set points = v.points + e.spent, updated_at = now()
    from wg_entries e
    where e.giveaway_id = p_giveaway and e.user_id = v.user_id and e.spent > 0;
    get diagnostics n = row_count;
  end if;
  update wg_giveaways set status = 'cancelled' where id = p_giveaway;
  return jsonb_build_object('ok', true, 'refunded', n);
end $$;

create or replace function wg_stats(p_giveaway uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('entrants', count(*) filter (where tickets > 0), 'tickets', coalesce(sum(tickets), 0))
  from wg_entries where giveaway_id = p_giveaway;
$$;

-- ---------- Points timer ----------
-- The function calls this itself the first time the streamer connects Twitch, with its own address.
-- It runs every minute; the function decides when it's time to give points.

create or replace function wg_schedule(p_url text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  select cron_key into k from wg_config where id = 1;
  perform cron.schedule(
    'ffy-web-giveaway',
    '* * * * *',
    format(
      'select net.http_post(url := %L, body := %L::jsonb, headers := %L::jsonb)',
      p_url,
      jsonb_build_object('action', 'cron', 'key', k)::text,
      '{"Content-Type": "application/json"}'
    )
  );
end $$;

create or replace function wg_unschedule()
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform cron.unschedule('ffy-web-giveaway');
exception when others then
  null;
end $$;

-- FFY_Points sends its balances (p_rows: [{"login","name","points"}]) and the ledger ids it has applied.
-- The website balance is Streamer.bot's balance minus anything Streamer.bot hasn't applied yet.
create or replace function wg_sync(p_rows jsonb, p_acks bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare pend jsonb;
begin
  update wg_ledger set applied = true where id = any (coalesce(p_acks, '{}')) and not applied;

  insert into wg_sb_points (login, display_name, points)
  select r.login, nullif(r.name, ''),
    greatest(r.points + coalesce((select sum(l.delta) from wg_ledger l where l.login = r.login and not l.applied), 0), 0)
  from (select distinct on (login) * from jsonb_to_recordset(coalesce(p_rows, '[]')) as x (login text, name text, points bigint)) r
  where r.login ~ '^[a-z0-9_]{1,25}$' and r.points is not null
  on conflict (login) do update set
    points = excluded.points,
    display_name = coalesce(excluded.display_name, wg_sb_points.display_name),
    updated_at = now();

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'delta', delta) order by id), '[]'::jsonb) into pend
  from (select id, login, delta from wg_ledger where not applied order by id limit 1000) x;

  return jsonb_build_object('pending', pend, 'acked', to_jsonb(coalesce(p_acks, '{}')));
end $$;

-- Give or take points when they come from Streamer.bot: changes the website copy now, and Streamer.bot on its next sync
create or replace function wg_give_sb(p_login text, p_name text, p_amount bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare old bigint; new bigint;
begin
  insert into wg_sb_points (login, display_name) values (p_login, p_name) on conflict (login) do nothing;
  select points into old from wg_sb_points where login = p_login for update;
  new := greatest(old + p_amount, 0);
  update wg_sb_points set points = new, display_name = coalesce(p_name, display_name), updated_at = now() where login = p_login;
  if new <> old then
    insert into wg_ledger (login, delta, reason) values (p_login, new - old, 'given');
  end if;
  return new;
end $$;

-- Only the function (service role) may call these
revoke all on function wg_buy(uuid, text, text, int, boolean) from public, anon, authenticated;
revoke all on function wg_award(jsonb, int, numeric) from public, anon, authenticated;
revoke all on function wg_give(text, text, text, bigint) from public, anon, authenticated;
revoke all on function wg_draw(uuid) from public, anon, authenticated;
revoke all on function wg_cancel(uuid) from public, anon, authenticated;
revoke all on function wg_stats(uuid) from public, anon, authenticated;
revoke all on function wg_schedule(text) from public, anon, authenticated;
grant execute on function wg_buy(uuid, text, text, int, boolean) to service_role;
grant execute on function wg_award(jsonb, int, numeric) to service_role;
grant execute on function wg_give(text, text, text, bigint) to service_role;
grant execute on function wg_draw(uuid) to service_role;
grant execute on function wg_cancel(uuid) to service_role;
grant execute on function wg_stats(uuid) to service_role;
grant execute on function wg_schedule(text) to service_role;
revoke all on function wg_unschedule() from public, anon, authenticated;
revoke all on function wg_sync(jsonb, bigint[]) from public, anon, authenticated;
revoke all on function wg_give_sb(text, text, bigint) from public, anon, authenticated;
grant execute on function wg_unschedule() to service_role;
grant execute on function wg_sync(jsonb, bigint[]) to service_role;
grant execute on function wg_give_sb(text, text, bigint) to service_role;

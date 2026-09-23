-- All mutations go through authenticated, transactional functions. No direct client writes.
create schema if not exists custody_private;
revoke all on schema custody_private from public;

create table public.family_workspaces (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 100),
  plan jsonb not null,
  revision integer not null default 0,
  created_at timestamptz not null default now()
);
create table public.family_members (
  workspace_id uuid references public.family_workspaces on delete cascade,
  user_id uuid references auth.users on delete cascade,
  parent_name text not null,
  role text not null check (role in ('owner','parent')),
  primary key (workspace_id,user_id), unique (workspace_id,parent_name)
);
create table public.family_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces on delete cascade,
  author_id uuid references auth.users on delete set null,
  author_name text not null,
  kind text not null check (kind in ('initial','upsert','delete')),
  base_revision integer not null,
  before_entry jsonb,
  after_entry jsonb,
  initial_plan jsonb,
  message text not null default '' check (length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn','stale')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users on delete set null
);
create table public.family_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces on delete cascade,
  actor_id uuid references auth.users on delete set null,
  actor_name text not null,
  action text not null,
  request_id uuid references public.family_requests on delete set null,
  created_at timestamptz not null default now()
);
create table custody_private.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces on delete cascade,
  email text not null,
  parent_name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  revoked_at timestamptz
);
create index on public.family_members(user_id);
create index on public.family_requests(workspace_id,created_at);
create index on public.family_events(workspace_id,created_at);

create function custody_private.is_member(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.family_members where workspace_id=w and user_id=auth.uid());
$$;
revoke all on function custody_private.is_member(uuid) from public;
grant usage on schema custody_private to authenticated;
grant execute on function custody_private.is_member(uuid) to authenticated;
alter table public.family_workspaces enable row level security;
alter table public.family_members enable row level security;
alter table public.family_requests enable row level security;
alter table public.family_events enable row level security;
alter table custody_private.invitations enable row level security;
create policy members_read on public.family_workspaces for select to authenticated using (custody_private.is_member(id));
create policy members_read on public.family_members for select to authenticated using (custody_private.is_member(workspace_id));
create policy members_read on public.family_requests for select to authenticated using (custody_private.is_member(workspace_id));
create policy members_read on public.family_events for select to authenticated using (custody_private.is_member(workspace_id));
revoke all on public.family_workspaces, public.family_members, public.family_requests, public.family_events from anon, authenticated;
grant select on public.family_workspaces, public.family_members, public.family_requests, public.family_events to authenticated;

create function custody_private.actor(w uuid) returns public.family_members
language plpgsql security definer set search_path = '' as $$
declare m public.family_members;
begin
  select * into m from public.family_members where workspace_id=w and user_id=auth.uid();
  if m.user_id is null then raise exception 'Workspace access is no longer available.'; end if;
  return m;
end $$;

create function custody_private.valid_entry(e jsonb, p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb;
begin
  if e is null or jsonb_typeof(e)<>'object' then return false; end if;
  if not (e ?& array['id','parent','beginDate','endDate','childrenPresent']) then return false; end if;
  for k in select jsonb_object_keys(e) loop
    if not k=any(array['id','parent','beginDate','endDate','childrenPresent','isException','exchangeTime','exchangePlace']) then return false; end if;
  end loop;
  if jsonb_typeof(e->'id')<>'string' or length(e->>'id') not between 1 and 200 or not (p->'parents' @> jsonb_build_array(e->'parent')) then return false; end if;
  if jsonb_typeof(e->'beginDate')<>'string' or jsonb_typeof(e->'endDate')<>'string' or (e->>'beginDate') !~ '^\d{4}-\d{2}-\d{2}$' or (e->>'endDate') !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  if (e->>'beginDate')::date > (e->>'endDate')::date then return false; end if;
  if jsonb_typeof(e->'childrenPresent')<>'object' or not exists(select 1 from jsonb_each(e->'childrenPresent') where value='true'::jsonb) then return false; end if;
  for k,v in select * from jsonb_each(e->'childrenPresent') loop
    if not (p->'children' ? k) or jsonb_typeof(v)<>'boolean' then return false; end if;
  end loop;
  if e ? 'isException' and jsonb_typeof(e->'isException')<>'boolean' then return false; end if;
  foreach k in array array['exchangeTime','exchangePlace'] loop
    if e ? k and (jsonb_typeof(e->k)<>'string' or length(e->>k)>300) then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;

create function custody_private.valid_plan(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; names jsonb;
begin
  if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>1000000 or not (p ?& array['parents','children','parentColors','childColors','entries']) then return false; end if;
  for k in select jsonb_object_keys(p) loop
    if not k=any(array['parents','children','parentColors','childColors','entries']) then return false; end if;
  end loop;
  if jsonb_array_length(p->'parents')<>2 or jsonb_array_length(p->'children') not between 1 and 100 or jsonb_array_length(p->'entries')>5000 then return false; end if;
  foreach k in array array['parents','children'] loop
    names=p->k;
    if exists(select 1 from jsonb_array_elements(names) n where jsonb_typeof(n)<>'string' or length(btrim(n#>>'{}')) not between 1 and 100 or n#>>'{}'=any(array['__proto__','constructor','prototype'])) then return false; end if;
    if (select count(distinct n) from jsonb_array_elements(names) n)<>jsonb_array_length(names) then return false; end if;
  end loop;
  foreach k in array array['parentColors','childColors'] loop
    if jsonb_typeof(p->k)<>'object' then return false; end if;
    names=case when k='parentColors' then p->'parents' else p->'children' end;
    if exists(select 1 from jsonb_each(p->k) c where not (names ? c.key) or jsonb_typeof(c.value)<>'string' or c.value#>>'{}' !~ '^#[a-fA-F0-9]{6}$') then return false; end if;
  end loop;
  for v in select * from jsonb_array_elements(p->'entries') loop
    if not custody_private.valid_entry(v,p) then return false; end if;
  end loop;
  if (select count(distinct n->>'id') from jsonb_array_elements(p->'entries') n)<>jsonb_array_length(p->'entries') then return false; end if;
  return true;
exception when others then return false;
end $$;

create function public.create_family(title text, plan jsonb, parent_name text, workspace_id uuid default gen_random_uuid()) returns uuid
language plpgsql security definer set search_path = '' as $$
declare w uuid; u uuid=auth.uid();
begin
  if u is null then raise exception 'Sign in first.'; end if;
  if not custody_private.valid_plan(plan) or not (plan->'parents' ? parent_name) then raise exception 'Check the family names and complete schedule before sharing.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,0));
  if exists(select 1 from public.family_workspaces f where f.id=workspace_id) then
    if exists(select 1 from public.family_members m join public.family_workspaces f on f.id=m.workspace_id
      join public.family_requests r on r.workspace_id=f.id and r.kind='initial'
      where f.id=create_family.workspace_id and m.user_id=u and m.role='owner' and m.parent_name=create_family.parent_name
      and r.author_id=u and r.initial_plan=create_family.plan and f.title=btrim(create_family.title)) then return workspace_id; end if;
    raise exception 'This workspace request already exists. Refresh before trying again.';
  end if;
  if (select count(*) from public.family_members where user_id=u)>=10 then raise exception 'The account workspace limit has been reached.'; end if;
  insert into public.family_workspaces(id,title,plan) values (workspace_id,btrim(title),jsonb_set(plan,'{entries}','[]')) returning id into w;
  insert into public.family_members values(w,u,parent_name,'owner');
  insert into public.family_requests(workspace_id,author_id,author_name,kind,base_revision,initial_plan) values(w,u,parent_name,'initial',0,plan);
  insert into public.family_events(workspace_id,actor_id,actor_name,action) values(w,u,parent_name,'Created workspace; starting schedule awaiting approval');
  return w;
end $$;

create function public.invite_parent(workspace uuid, email text) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.family_members; p jsonb; target text; token text;
begin
  select plan into p from public.family_workspaces where id=workspace for update;
  m=custody_private.actor(workspace);
  if m.role<>'owner' then raise exception 'Only the workspace owner can invite a parent.'; end if;
  if (select count(*) from public.family_members where workspace_id=workspace)<>1 then raise exception 'Both parents already have access.'; end if;
  if email is null or length(email)>254 or btrim(email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email address.'; end if;
  if exists(select 1 from auth.users u where u.id=auth.uid() and lower(u.email)=lower(btrim(invite_parent.email))) then raise exception 'Invite the other parent, not your own account.'; end if;
  if (select count(*) from custody_private.invitations where workspace_id=workspace and created_at>now()-interval '1 day')>=10 then raise exception 'Too many invitations today. Try again tomorrow.'; end if;
  select n into target from jsonb_array_elements_text(p->'parents') n where n<>m.parent_name;
  token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  update custody_private.invitations set revoked_at=now() where workspace_id=workspace and used_at is null and revoked_at is null;
  insert into custody_private.invitations(workspace_id,email,parent_name,token_hash) values(workspace,lower(btrim(email)),target,encode(sha256(convert_to(token,'UTF8')),'hex'));
  insert into public.family_events(workspace_id,actor_id,actor_name,action) values(workspace,auth.uid(),m.parent_name,'Created invitation; older invitations revoked');
  return token;
end $$;

create function public.join_family(token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i custody_private.invitations; w uuid; verified text;
begin
  select lower(email) into verified from auth.users where id=auth.uid() and email_confirmed_at is not null;
  if verified is null then raise exception 'Verify your email before joining.'; end if;
  select workspace_id into w from custody_private.invitations where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex');
  perform 1 from public.family_workspaces where id=w for update;
  select * into i from custody_private.invitations where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') for update;
  if i.id is null or i.email<>verified or i.used_at is not null or i.revoked_at is not null or i.expires_at<=now() then raise exception 'Invitation is invalid, expired, or for another email address.'; end if;
  if exists(select 1 from public.family_members where workspace_id=w and user_id=auth.uid()) then raise exception 'This account already belongs to this workspace.'; end if;
  insert into public.family_members values(w,auth.uid(),i.parent_name,'parent');
  update custody_private.invitations set used_at=now() where id=i.id;
  insert into public.family_events(workspace_id,actor_id,actor_name,action) values(w,auth.uid(),i.parent_name,'Joined workspace');
  return w;
end $$;

create function public.propose_change(workspace uuid, request_id uuid, base_revision integer, kind text, entry jsonb, entry_id text, message text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare w public.family_workspaces; m public.family_members; previous jsonb; existing public.family_requests;
begin
  select * into w from public.family_workspaces where id=workspace for update;
  m=custody_private.actor(workspace);
  select * into existing from public.family_requests where id=request_id;
  if existing.id is not null then
    if existing.workspace_id=workspace and existing.author_id=auth.uid() and existing.kind=kind and existing.base_revision=base_revision
      and existing.message=coalesce(message,'') and coalesce(existing.after_entry->>'id',existing.before_entry->>'id')=entry_id
      and existing.after_entry is not distinct from (case when kind='upsert' then entry else null end) then return existing.id; end if;
    raise exception 'Request ID is already in use.';
  end if;
  if w.revision=0 then raise exception 'The starting schedule needs approval first.'; end if;
  if w.revision<>base_revision then raise exception 'The schedule changed. Refresh and review before proposing again.'; end if;
  if kind is null or kind not in ('upsert','delete') then raise exception 'Invalid request type.'; end if;
  if kind='upsert' and (not custody_private.valid_entry(entry,w.plan) or entry->>'id' is distinct from entry_id) then raise exception 'Complete the parent, dates, and children for this period.'; end if;
  select e into previous from jsonb_array_elements(w.plan->'entries') e where e->>'id'=entry_id;
  if kind='delete' and previous is null then raise exception 'This period no longer exists.'; end if;
  if kind='upsert' and previous=entry then raise exception 'No schedule changes to request.'; end if;
  if kind='upsert' and previous is null and jsonb_array_length(w.plan->'entries')>=5000 then raise exception 'The schedule has reached its entry limit.'; end if;
  if (select count(*) from public.family_requests where workspace_id=workspace and status='pending')>=100 then raise exception 'Resolve pending requests before adding more.'; end if;
  insert into public.family_requests(id,workspace_id,author_id,author_name,kind,base_revision,before_entry,after_entry,message)
    values(request_id,workspace,auth.uid(),m.parent_name,kind,base_revision,previous,case when kind='upsert' then entry else null end,coalesce(message,''));
  insert into public.family_events(workspace_id,actor_id,actor_name,action,request_id) values(workspace,auth.uid(),m.parent_name,'Proposed schedule change',request_id);
  return request_id;
end $$;

create function public.decide_change(request_id uuid, decision text) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.family_requests; w public.family_workspaces; m public.family_members; next_plan jsonb;
begin
  select workspace_id into w.id from public.family_requests where id=request_id;
  select * into w from public.family_workspaces where id=w.id for update;
  m=custody_private.actor(w.id);
  select * into r from public.family_requests where id=request_id for update;
  if r.status<>'pending' then raise exception 'This request has already been resolved. Refresh the workspace.'; end if;
  if decision is null or decision not in ('accepted','declined','withdrawn') then raise exception 'Invalid decision.'; end if;
  if decision='withdrawn' then
    if r.author_id is distinct from auth.uid() or r.kind='initial' then raise exception 'Only the author can withdraw this change.'; end if;
  elsif r.author_id is not distinct from auth.uid() then raise exception 'The other parent must respond to your request.';
  end if;
  if decision='accepted' then
    if r.base_revision<>w.revision then raise exception 'This request is outdated. Ask for a new proposal.'; end if;
    if r.kind='initial' then next_plan=r.initial_plan;
    else
      select jsonb_set(w.plan,'{entries}',coalesce(jsonb_agg(e),'[]')) into next_plan from jsonb_array_elements(w.plan->'entries') e where e->>'id'<>coalesce(r.after_entry->>'id',r.before_entry->>'id');
      if r.kind='upsert' then next_plan=jsonb_set(next_plan,'{entries}',next_plan->'entries'||jsonb_build_array(r.after_entry)); end if;
    end if;
    if not custody_private.valid_plan(next_plan) then raise exception 'The resulting schedule is invalid.'; end if;
    update public.family_workspaces set plan=next_plan,revision=revision+1 where id=w.id;
    update public.family_requests set status='stale',decided_at=now() where workspace_id=w.id and status='pending' and id<>request_id;
  end if;
  update public.family_requests set status=decision,decided_at=now(),decided_by=auth.uid() where id=request_id;
  insert into public.family_events(workspace_id,actor_id,actor_name,action,request_id) values(w.id,auth.uid(),m.parent_name,decision||' schedule request',request_id);
  return decision;
end $$;

create function public.remove_family_access(workspace uuid, member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.family_members; target public.family_members;
begin
  perform 1 from public.family_workspaces where id=workspace for update;
  m=custody_private.actor(workspace);
  if m.role<>'owner' and member_id is distinct from auth.uid() then raise exception 'You cannot remove another member.'; end if;
  select * into target from public.family_members where workspace_id=workspace and user_id=member_id;
  if target.user_id is null then raise exception 'Member no longer has access.'; end if;
  if target.role='owner' then raise exception 'The owner must delete the workspace or account instead.'; end if;
  delete from public.family_members where workspace_id=workspace and user_id=member_id;
  update public.family_requests set status='withdrawn',decided_at=now() where workspace_id=workspace and author_id=member_id and status='pending';
  update custody_private.invitations set revoked_at=now() where workspace_id=workspace and revoked_at is null;
  insert into public.family_events(workspace_id,actor_id,actor_name,action) values(workspace,auth.uid(),m.parent_name,'Removed access for '||target.parent_name);
end $$;

create function public.revoke_family_invitations(workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.family_members;
begin
  perform 1 from public.family_workspaces where id=workspace for update;
  m=custody_private.actor(workspace);
  if m.role<>'owner' then raise exception 'Only the owner can revoke invitations.'; end if;
  update custody_private.invitations set revoked_at=now() where workspace_id=workspace and revoked_at is null and used_at is null;
end $$;

create function public.delete_family(workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.family_members;
begin
  perform 1 from public.family_workspaces where id=workspace for update;
  m=custody_private.actor(workspace);
  if m.role<>'owner' then raise exception 'Only the owner can delete this workspace.'; end if;
  delete from public.family_workspaces where id=workspace;
end $$;

create function public.delete_custody_account() returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid=auth.uid(); w uuid;
begin
  if u is null or not exists(select 1 from auth.users where id=u and last_sign_in_at>now()-interval '15 minutes') then raise exception 'Sign out and sign in again before deleting your account.'; end if;
  -- Retain the other parent's schedule; transfer ownership before removing this account.
  for w in select workspace_id from public.family_members where user_id=u order by workspace_id loop
    perform 1 from public.family_workspaces where id=w for update;
    update custody_private.invitations set revoked_at=now() where workspace_id=w and revoked_at is null;
    update public.family_requests set status='withdrawn',decided_at=now() where workspace_id=w and author_id=u and status='pending';
    if (select count(*) from public.family_members where workspace_id=w)=1 then delete from public.family_workspaces where id=w;
    else
      if exists(select 1 from public.family_members where workspace_id=w and user_id=u and role='owner') then update public.family_members set role='owner' where workspace_id=w and user_id<>u; end if;
      insert into public.family_events(workspace_id,actor_id,actor_name,action) values(w,null,'Former member','Deleted account; shared schedule retained for remaining parent');
    end if;
  end loop;
  delete from auth.users where id=u;
end $$;

revoke all on all functions in schema custody_private from public, anon, authenticated;
grant execute on function custody_private.is_member(uuid) to authenticated;
revoke all on function public.create_family(text,jsonb,text,uuid), public.invite_parent(uuid,text), public.join_family(text), public.propose_change(uuid,uuid,integer,text,jsonb,text,text), public.decide_change(uuid,text), public.remove_family_access(uuid,uuid), public.revoke_family_invitations(uuid), public.delete_family(uuid), public.delete_custody_account() from public, anon;
grant execute on function public.create_family(text,jsonb,text,uuid), public.invite_parent(uuid,text), public.join_family(text), public.propose_change(uuid,uuid,integer,text,jsonb,text,text), public.decide_change(uuid,text), public.remove_family_access(uuid,uuid), public.revoke_family_invitations(uuid), public.delete_family(uuid), public.delete_custody_account() to authenticated;

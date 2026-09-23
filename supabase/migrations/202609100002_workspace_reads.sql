create function public.family_state(workspace uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'workspace',to_jsonb(w),
    'members',(select coalesce(jsonb_agg(m),'[]') from public.family_members m where m.workspace_id=w.id),
    'requests',(select coalesce(jsonb_agg(r order by r.created_at desc),'[]') from
      (select * from public.family_requests where workspace_id=w.id order by (status='pending') desc,created_at desc limit 300) r),
    'events',(select coalesce(jsonb_agg(e order by e.created_at desc),'[]') from
      (select * from public.family_events where workspace_id=w.id order by created_at desc limit 100) e)
  ) from public.family_workspaces w where w.id=workspace;
$$;

create function public.propose_starting_plan(workspace uuid, plan jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare w public.family_workspaces; m public.family_members; r uuid;
begin
  select * into w from public.family_workspaces where id=workspace for update;
  m=custody_private.actor(workspace);
  if w.revision<>0 then raise exception 'A starting schedule is already agreed.'; end if;
  if not custody_private.valid_plan(plan) or plan->'parents'<>w.plan->'parents' or plan->'children'<>w.plan->'children' then raise exception 'The starting plan must contain the same family members.'; end if;
  if exists(select 1 from public.family_requests where workspace_id=workspace and status='pending') then raise exception 'Respond to the pending starting schedule first.'; end if;
  insert into public.family_requests(workspace_id,author_id,author_name,kind,base_revision,initial_plan) values(workspace,auth.uid(),m.parent_name,'initial',0,plan) returning id into r;
  insert into public.family_events(workspace_id,actor_id,actor_name,action,request_id) values(workspace,auth.uid(),m.parent_name,'Proposed starting schedule',r);
  return r;
end $$;
revoke all on function public.family_state(uuid), public.propose_starting_plan(uuid,jsonb) from public,anon;
grant execute on function public.family_state(uuid), public.propose_starting_plan(uuid,jsonb) to authenticated;

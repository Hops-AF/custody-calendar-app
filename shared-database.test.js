const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const A='00000000-0000-4000-8000-000000000001', B='00000000-0000-4000-8000-000000000002', C='00000000-0000-4000-8000-000000000003';
const entry={id:'period',parent:'Jordan',beginDate:'2026-09-11',endDate:'2026-09-13',childrenPresent:{Sam:true},exchangePlace:'School'};
const plan={parents:['Alex','Jordan'],children:['Sam'],parentColors:{Alex:'#112233'},childColors:{},entries:[entry]};
let db;
before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
  for(const f of fs.readdirSync(path.join(__dirname,'supabase/migrations')).sort()) await db.exec(fs.readFileSync(path.join(__dirname,'supabase/migrations',f),'utf8'));
  await db.query("insert into auth.users values ($1,'alex@example.test',now(),now()),($2,'jordan@example.test',now(),now()),($3,'outsider@example.test',now(),now())",[A,B,C]);
});
after(async()=>db?.close());
beforeEach(async()=>db.exec('begin'));
afterEach(async()=>db.exec('rollback'));
async function as(user,sql,args=[]){
  await db.exec('savepoint request');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user||'']);
    await db.exec(`set local role ${user?'authenticated':'anon'}`);
    const result=await db.query(sql,args);
    await db.exec('reset role; release savepoint request');
    return result.rows;
  } catch(e){await db.exec('rollback to savepoint request; reset role; release savepoint request');throw e;}
}
const rpc=async(user,fn,args=[]) => (await as(user,`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args))[0].value;
async function family(accepted=false){
  const id=await rpc(A,'create_family',['QA family',plan,'Alex']);
  const token=await rpc(A,'invite_parent',[id,'jordan@example.test']);
  await rpc(B,'join_family',[token]);
  const state=await rpc(A,'family_state',[id]);
  if(accepted) await rpc(B,'decide_change',[state.requests[0].id,'accepted']);
  return id;
}
const propose=(user,w,overrides={})=>rpc(user,'propose_change',[w,randomUUID(),1,'upsert',{...entry,exchangePlace:'Library',...overrides},entry.id,'Please meet here']);

test('anonymous and unrelated users cannot read or mutate family data',async()=>{
  const w=await family();
  await assert.rejects(as(null,'select * from public.family_workspaces'),/permission denied/);
  assert.deepEqual(await as(C,'select * from public.family_workspaces'),[]);
  assert.deepEqual(await as(C,'select * from public.family_members'),[]);
  assert.deepEqual(await as(C,'select * from public.family_requests'),[]);
  assert.equal(await rpc(C,'family_state',[w]),null);
  await assert.rejects(rpc(C,'invite_parent',[w,'outsider@example.test']),/access/);
  await assert.rejects(as(A,'update public.family_workspaces set revision=100 where id=$1',[w]),/permission denied/);
  await assert.rejects(as(A,'select * from custody_private.invitations'),/permission denied/);
});
test('starting plan requires the other parent; joining does not imply acceptance',async()=>{
  const w=await family();let state=await rpc(A,'family_state',[w]);
  assert.equal(state.workspace.revision,0);assert.deepEqual(state.workspace.plan.entries,[]);
  await assert.rejects(rpc(A,'decide_change',[state.requests[0].id,'accepted']),/other parent/);
  await rpc(B,'decide_change',[state.requests[0].id,'accepted']);
  state=await rpc(A,'family_state',[w]); assert.equal(state.workspace.revision,1);assert.deepEqual(state.workspace.plan,plan);
});
test('invites require the bound verified email and are single use',async()=>{
  const w=await rpc(A,'create_family',['QA',plan,'Alex']);const token=await rpc(A,'invite_parent',[w,'jordan@example.test']);
  await assert.rejects(rpc(C,'join_family',[token]),/another email/);
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[B]);
  await assert.rejects(rpc(B,'join_family',[token]),/Verify/);
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[B]);
  assert.equal(await rpc(B,'join_family',[token]),w);
  await assert.rejects(rpc(B,'join_family',[token]),/invalid/);
});
test('expired and revoked invitations fail without changing membership',async()=>{
  const w=await rpc(A,'create_family',['QA',plan,'Alex']);const token=await rpc(A,'invite_parent',[w,'jordan@example.test']);
  await db.exec("update custody_private.invitations set expires_at=now()-interval '1 second'");
  await assert.rejects(rpc(B,'join_family',[token]),/expired/);
  const next=await rpc(A,'invite_parent',[w,'jordan@example.test']);
  await rpc(A,'revoke_family_invitations',[w]);
  await assert.rejects(rpc(B,'join_family',[next]),/invalid/);
});
test('server allowlists reject notes and malformed data even if client validation is bypassed',async()=>{
  await assert.rejects(rpc(A,'create_family',['QA',{...plan,privateNotes:'secret'},'Alex']),/Check/);
  const w=await family(true);
  for(const invalid of [{note:'secret'},{beginDate:'2026-02-30'},{beginDate:null},{endDate:null},{parent:'Nobody'},{childrenPresent:{Someone:true}},{exchangePlace:null},{isException:null}]) await assert.rejects(propose(A,w,invalid),/Complete/);
});
test('pending changes do not modify schedule; decline and withdraw preserve it',async()=>{
  const w=await family(true);let id=await propose(A,w);
  assert.deepEqual((await rpc(B,'family_state',[w])).workspace.plan,plan);
  await rpc(B,'decide_change',[id,'declined']);
  assert.deepEqual((await rpc(A,'family_state',[w])).workspace.plan,plan);
  id=await propose(A,w);
  await assert.rejects(rpc(B,'decide_change',[id,'withdrawn']),/author/);
  await rpc(A,'decide_change',[id,'withdrawn']);
  assert.deepEqual((await rpc(B,'family_state',[w])).workspace.plan,plan);
});
test('acceptance is atomic and marks competing proposals stale',async()=>{
  const w=await family(true);const first=await propose(A,w),second=await propose(B,w,{exchangePlace:'Park'});
  await rpc(B,'decide_change',[first,'accepted']);
  const state=await rpc(A,'family_state',[w]);assert.equal(state.workspace.revision,2);assert.equal(state.workspace.plan.entries[0].exchangePlace,'Library');
  assert.equal(state.requests.find(r=>r.id===second).status,'stale');
  await assert.rejects(rpc(A,'decide_change',[second,'accepted']),/already/);
  await assert.rejects(propose(A,w),/schedule changed/);
});
test('proposal retries with the same ID do not duplicate requests',async()=>{
  const w=await family(true),id=randomUUID(),args=[w,id,1,'upsert',{...entry,exchangePlace:'Park'},entry.id,''];
  assert.equal(await rpc(A,'propose_change',args),id);assert.equal(await rpc(A,'propose_change',args),id);
  assert.equal((await rpc(A,'family_state',[w])).requests.filter(r=>r.id===id).length,1);
  await assert.rejects(rpc(A,'propose_change',[...args.slice(0,6),'A different reason']),/already/);
});
test('workspace creation retries cannot duplicate a family or silently change its initial plan',async()=>{
  const id=randomUUID(),args=['Family',plan,'Alex',id];
  assert.equal(await rpc(A,'create_family',args),id);assert.equal(await rpc(A,'create_family',args),id);
  await assert.rejects(rpc(A,'create_family',['Family',{...plan,entries:[]},'Alex',id]),/already/);
  assert.equal((await as(A,'select * from public.family_workspaces')).length,1);
});
test('deleted periods require approval and preserve before/after history',async()=>{
  const w=await family(true),id=await rpc(A,'propose_change',[w,randomUUID(),1,'delete',null,entry.id,'']);
  await rpc(B,'decide_change',[id,'accepted']);
  const state=await rpc(A,'family_state',[w]);assert.deepEqual(state.workspace.plan.entries,[]);assert.deepEqual(state.requests.find(r=>r.id===id).before_entry,entry);
});
test('revoked members cannot read or respond and invitations cannot restore removed access',async()=>{
  const w=await family(true),id=await propose(A,w);
  await assert.rejects(rpc(B,'remove_family_access',[w,A]),/cannot/);
  await rpc(A,'remove_family_access',[w,B]);
  assert.equal(await rpc(B,'family_state',[w]),null);
  await assert.rejects(rpc(B,'decide_change',[id,'accepted']),/access/);
});
test('declined starting schedules can be proposed again',async()=>{
  const w=await family(),state=await rpc(B,'family_state',[w]);
  await rpc(B,'decide_change',[state.requests[0].id,'declined']);
  const id=await rpc(B,'propose_starting_plan',[w,{...plan,entries:[]}]);
  await rpc(A,'decide_change',[id,'accepted']);assert.equal((await rpc(A,'family_state',[w])).workspace.revision,1);
});
test('account deletion transfers shared ownership, removes solo workspaces, and ends access',async()=>{
  const w=await family(true);const solo=await rpc(A,'create_family',['Solo',plan,'Alex']);
  await rpc(A,'delete_custody_account');
  assert.equal((await db.query('select * from auth.users where id=$1',[A])).rows.length,0);
  assert.equal((await db.query('select * from public.family_workspaces where id=$1',[solo])).rows.length,0);
  const state=await rpc(B,'family_state',[w]);assert.equal(state.members[0].role,'owner');assert.deepEqual(state.workspace.plan,plan);
  assert.equal(await rpc(A,'family_state',[w]),null);
});
test('deletion requires recent sign-in and parent cannot delete another workspace',async()=>{
  const w=await family();await assert.rejects(rpc(B,'delete_family',[w]),/owner/);
  await db.query("update auth.users set last_sign_in_at=now()-interval '1 hour' where id=$1",[A]);
  await assert.rejects(rpc(A,'delete_custody_account'),/Sign out/);
  await rpc(A,'delete_family',[w]);assert.equal(await rpc(B,'family_state',[w]),null);
});

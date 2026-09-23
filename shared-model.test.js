const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('./local-store');
const { sharedPlan, publicEntry, requestSummary } = require('./shared-model');
const { createSecureSessionStore } = require('./secure-session-store');

test('shared plan uses allowlists, excluding notes, contacts, history and future fields', () => {
  const d = { ...defaults(), parents: ['Alex','Jordan'], children: ['Sam'], parentLocations: { Alex: 'Private home' }, parentPhones: { Alex: '555' },
    parentColors: { Alex:'#112233',Removed:'#123456' }, privateStuff:'secret',
    entries: [{ id:'e',parent:'Jordan',beginDate:'2026-09-12',endDate:'2026-09-14',childrenPresent:{ Sam:true,Removed:true },note:'private note',location:'private location',scheduleId:'local',exchangePlace:'School', futureSecret:'secret' }] };
  const p = sharedPlan(d), raw = JSON.stringify(p);
  for (const secret of ['Private home','555','private note','private location','futureSecret','scheduleId','Removed']) assert.equal(raw.includes(secret),false,secret);
  assert.equal(p.entries[0].exchangePlace,'School');
  assert.equal(d.entries[0].note,'private note');
});
test('incomplete personal entries cannot be silently dropped during sharing', () => {
  assert.throws(() => sharedPlan(defaults()),/two parents/);
  assert.throws(() => sharedPlan({ ...defaults(),parents:['Alex','Jordan'],children:['Sam'],entries:[{ id:'e',parent:'',beginDate:'',endDate:'',childrenPresent:{ Sam:true } }] }),/incomplete/);
});
test('request labels distinguish starting, adding, changing and removal', () => {
  assert.equal(requestSummary({kind:'initial'}),'Starting schedule');
  const e = {parent:'Alex',beginDate:'2026-01-01',endDate:'2026-01-02'};
  assert.match(requestSummary({kind:'upsert',after_entry:e}),/^Add:/);
  assert.match(requestSummary({kind:'delete',before_entry:e}),/^Remove:/);
  assert.deepEqual(publicEntry({...e,note:'secret'}),e);
});
test('secure sessions round-trip large Unicode values and delete old chunks', async () => {
  const map = new Map(); let id=0;
  const api = {getItemAsync:async(k)=>map.get(k)??null,setItemAsync:async(k,v)=>{assert.ok(Buffer.byteLength(v)<2048);map.set(k,v);},deleteItemAsync:async(k)=>map.delete(k)};
  const store=createSecureSessionStore(api,()=>String(++id));
  const value=JSON.stringify({token:'a'.repeat(6000),name:'Zoë 😀'.repeat(30)});
  await store.setItem('auth',value); assert.equal(await store.getItem('auth'),value);
  await store.setItem('auth','next'); assert.equal(await store.getItem('auth'),'next'); assert.equal(map.size,2);
  await store.removeItem('auth'); assert.equal(map.size,0); assert.equal(await store.getItem('auth'),null);
});
test('failed secure session writes retain previous sign-in', async () => {
  const map=new Map();let id=0,fail=false;
  const store=createSecureSessionStore({getItemAsync:async(k)=>map.get(k)??null,setItemAsync:async(k,v)=>{if(fail&&k.endsWith('.1'))throw Error('Keychain unavailable');map.set(k,v);},deleteItemAsync:async(k)=>map.delete(k)},()=>String(++id));
  await store.setItem('auth','original');fail=true;
  await assert.rejects(store.setItem('auth','b'.repeat(1000)),/Keychain/);
  assert.equal(await store.getItem('auth'),'original');
});

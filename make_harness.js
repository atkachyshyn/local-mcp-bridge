// Builds a LIVE harness page: real protocol.js + presentation.js running in the
// browser against a stubbed coordinator, so interactions can actually be tested.
const fs = require('fs');

const TITLES = ['Rotate repo hygiene token','Load bridge config','Freeze LBP to 1.3','Resolve identities & state','Task registration','Conservative mutation check','Approval scopes & path policy','Extension protocol validation'];

const boot = `
const TITLES = ${JSON.stringify(TITLES)};
const items = TITLES.map((t,i)=>({id:'p'+(i+1),phase:'execute',title:t,status:i<2?'completed':i===2?'current':'pending'}));
const base = new Date(); base.setHours(14,2,11,0);
const STATE = {schema:2,conversation_id:'conv-'+'0'.repeat(32),revision:9,enabled:true,workflow_attached:true,
  mode:'auto_continue',checkpoint_size:12,phase:'executing',
  active_chain:{chain_id:'c1',human_turn_id:'msg:u1',window:0,window_limit:12,window_task_count:3,total_task_count:3,checkpoint_continue_requested:false},
  current_task_id:'t3',current_registration:'r3',
  plan:{id:'pl',revision:1,title:'Stabilize',items,begun:true,chain_id:'c1'},
  recent_tasks:items.slice(0,3).map((it,i)=>({registration_id:'r'+(i+1),task_id:'t'+(i+1),title:it.title,sequence:i+1,window:0,window_position:i+1,plan_item_id:it.id,execution_status:i<2?'completed':'running',delivery_status:i<2?'submitted':'none',updated_at:Math.floor((base.getTime()+i*1000)/1000)})),
  outputs:[],context:{sources:[{id:'s1',kind:'folder',label:'local-mcp-bridge',origin:'user',accessible:true,removable:true}],servers:['konnect','workspace'],constraints:[]},owner:null};
const views = new Map([['t1',{status:'completed'}],['t2',{status:'completed'}],['t3',{status:'running',detail:'Align tests'}]]);
let interaction = {mode:'auto_continue',max_round_trips:12,status_surface:'panel',show_protocol_payloads:true};
window.chrome = {storage:{local:{get:()=>Promise.resolve({}),set:()=>Promise.resolve()},onChanged:{addListener(){}}},runtime:{sendMessage:()=>Promise.resolve({ok:true,payload:{}}),id:'t'}};
globalThis.LBP_PROVIDER_ADAPTER = {messageHosts:()=>[],protocolBlocks:()=>[],sourceText:()=>''};
globalThis.LBP_COORDINATOR = {state:()=>STATE,stateStatus:()=>({kind:'ok'}),
  status:()=>({kind:'connected',text:'Connected',detail:'',busy:false}),
  identity:()=>({bridgeVersion:'0.9.2',lbpVersion:'1.3'}),
  interaction:()=>interaction,taskViews:()=>views,
  setInteraction:(n)=>{interaction=n;},
  updateInteraction:(n)=>{interaction={...interaction,...n};STATE.mode=n.mode;return Promise.resolve();},
  enable:()=>Promise.resolve(),stop:()=>Promise.resolve(),continueCheckpoint:()=>Promise.resolve(),
  redeliverResult:()=>Promise.resolve(),addContextSource:()=>Promise.resolve(),
  removeContextSource:()=>Promise.resolve(),chooseContextFolder:()=>Promise.resolve({cancelled:true}),
  configuredContextSources:()=>Promise.resolve([])};
`;

const page = `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;min-height:100vh;background:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,Arial,sans-serif}
${fs.readFileSync('extension/style.css','utf8')}
</style></head><body>
<script>${boot}<\/script>
<script>${fs.readFileSync('extension/protocol.js','utf8')}<\/script>
<script>${fs.readFileSync('extension/presentation.js','utf8')}<\/script>
<script>
  if (location.search.includes('disabled')) {
    // The state the user reported: chat disabled, but the configured mode is
    // auto_continue. The sidebar used to render "Manual" + toggle off here.
    STATE.enabled = false; STATE.phase = 'disabled';
    STATE.active_chain = null; STATE.plan = null; STATE.recent_tasks = [];
    STATE.context.constraints = ['Checkpoint = 12', 'LBP 1.3 + 1.2 only'];
  }
  if (location.search.includes('empty')) {
    STATE.active_chain = null; STATE.plan = null; STATE.recent_tasks = [];
    STATE.phase = 'idle'; STATE.current_task_id = null; STATE.current_registration = null;
    STATE.context.constraints = ['Checkpoint = 12', 'LBP 1.3 + 1.2 only'];
  }
  globalThis.LBP_PRESENTATION.ensureUi();
  globalThis.LBP_PRESENTATION.render();
  document.querySelector('.lbp-panel').hidden = false;   // start expanded for the shot
<\/script>
</body></html>`;
fs.writeFileSync('harness.html', page);
console.log('live harness.html written');

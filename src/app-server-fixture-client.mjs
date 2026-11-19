// Offline-only direct protocol client. No model turn or real connector configuration.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function createFixtureClient({directory,node,executable,fixture}){
 const home=join(directory,'codex-home'),cwd=join(directory,'workspace');
 for(const name of ['codex-home','workspace','profile','appdata','localappdata','temp'])mkdirSync(join(directory,name),{recursive:true});
 const toml=value=>JSON.stringify(value.replaceAll('\\','/'));
 writeFileSync(join(home,'config.toml'),`model = "offline-proof-model"
model_provider = "offline"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
web_search = "disabled"
[analytics]
enabled = false
[features]
apps = false
hooks = false
multi_agent = false
shell_tool = false
[model_providers.offline]
name = "Offline fixture only"
base_url = "http://127.0.0.1:9"
wire_api = "responses"
requires_openai_auth = false
[mcp_servers.elya_fake]
command = ${toml(node)}
args = [${toml(fixture)}, ${toml(directory)}]
startup_timeout_sec = 5
tool_timeout_sec = 60
enabled_tools = ["read_fixture"]
default_tools_approval_mode = "approve"
`);
 const win=process.env.SystemRoot??'C:\\Windows';
 const env={SystemRoot:win,WINDIR:win,COMSPEC:join(win,'System32','cmd.exe'),PATH:join(win,'System32'),TEMP:join(directory,'temp'),TMP:join(directory,'temp'),USERPROFILE:join(directory,'profile'),HOME:join(directory,'profile'),APPDATA:join(directory,'appdata'),LOCALAPPDATA:join(directory,'localappdata'),CODEX_HOME:home,HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost'};
 let child,threadId,sequence=0,used=false;
 const pending=new Map(),allowed=new Set(['initialize','thread/start','mcpServerStatus/list','mcpServer/tool/call']);
 const audit=record=>appendFileSync(join(directory,'rpc.jsonl'),JSON.stringify({at:new Date().toISOString(),...record})+'\n');
 function request(method,params){
  if(!allowed.has(method))throw Error('UNAPPROVED_RPC_METHOD');
  const id=++sequence;audit({event:'REQUEST',method,params});
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 }
 async function initialize(){
  child=spawn(executable,['--no-daemon','app-server','--stdio','--strict-config'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  audit({event:'SPAWN',pid:child.pid});
  const fail=()=>{for(const p of pending.values())p.reject(Error('APP_SERVER_UNAVAILABLE'));pending.clear();};
  child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
  // Do not persist raw runtime diagnostics. Only deterministic protocol metadata.
  child.stderr.on('data',()=>{});
  createInterface({input:child.stdout}).on('line',line=>{
   let message;try{message=JSON.parse(line);}catch{fail();return;}
   if(message.id!==undefined&&pending.has(message.id)){
    const p=pending.get(message.id);pending.delete(message.id);
    audit({event:'RESPONSE',id:message.id,error:!!message.error});
    message.error?p.reject(Error('APP_SERVER_RPC_ERROR')):p.resolve(message.result);
   }else if(message.id!==undefined&&message.method){
    audit({event:'UNEXPECTED_REQUEST',method:message.method});
    child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'No additional actions permitted'}})+'\n');fail();
   }
  });
  await request('initialize',{clientInfo:{name:'elya_offline_integration',version:'1.0'},capabilities:{experimentalApi:true,explicitGatewayOauth:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const thread=await request('thread/start',{cwd,ephemeral:true,model:'offline-proof-model',modelProvider:'offline',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',environments:[],experimentalRawEvents:false,allowProviderModelFallback:false});
  if(typeof thread?.thread?.id!=='string')throw Error('INVALID_THREAD_RESPONSE');threadId=thread.thread.id;
  await request('mcpServerStatus/list',{threadId,serverName:'elya_fake',detail:'toolsAndAuthOnly'});
 }
 return {mode:'offline',async execute(call,permit){
  if(used)throw Error('ONE_CALL_ONLY');used=true;
  await initialize();
  // The durable adapter validates the complete call again at this final boundary.
  const exact=permit(call);
  return request('mcpServer/tool/call',{threadId,...exact});
 }};
}

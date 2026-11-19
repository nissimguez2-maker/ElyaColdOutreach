// Summarize discovery by allowlist. Never retain raw errors, cursors, unknown
// field names, URLs, tool catalogs, or unrelated server/resource metadata.
const authStates=['unknown','unsupported','notLoggedIn','bearerToken','oAuth'];
const runtimeStates=['notStarted','starting','connected','authenticationRequired','failed','cancelled','disabled'];
const serverFields=['name','authStatus','runtimeStatus','tools','toolsError','resources','resourceTemplates','httpOrigin','pluginId','serverCapabilities','serverInfo','toolListMeta'];
const type=value=>value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value;
const object=value=>type(value)==='object';
const status=(value,known)=>({type:type(value),value:known.includes(value)?value:'UNRECOGNIZED'});
const extras=(value,known)=>object(value)?Object.keys(value).filter(k=>!known.includes(k)).length:0;

export function inspectDiscovery(inventory,call){
 const data=inventory?.data;
 const invalidEntries=Array.isArray(data)?data.filter(s=>!object(s)).length:0;
 const servers=Array.isArray(data)?data.filter(s=>object(s)&&s.name===call.server):[];
 const server=servers.length===1?servers[0]:undefined;
 // Object.values matches the existing selection semantics, including arrays.
 const tools=server?.tools==null?[]:Object.values(server.tools);
 const invalidTools=tools.filter(t=>t==null).length;
 const matches=tools.filter(t=>t!=null&&t.name===call.tool);
 const evidence={
  event:'DISCOVERY_STATUS_OBSERVED',provider:call.provider,server:call.server,tool:call.tool,
  fields:{response:type(inventory),data:type(data),nextCursor:type(inventory?.nextCursor),
   authStatus:type(server?.authStatus),runtimeStatus:type(server?.runtimeStatus),toolsError:type(server?.toolsError),tools:type(server?.tools)},
  matchingServerCount:servers.length,invalidServerEntryCount:invalidEntries,
  invalidServerNameCount:Array.isArray(data)?data.filter(s=>typeof s?.name!=='string').length:0,
  paginationIncomplete:!!inventory?.nextCursor,
  authStatus:status(server?.authStatus,authStates),runtimeStatus:status(server?.runtimeStatus,runtimeStates),
  toolsError:{type:type(server?.toolsError),present:!!server?.toolsError},
  matchingToolCount:server?matches.length:null,invalidToolEntryCount:server?invalidTools:null,
  unexpectedResponseFieldCount:extras(inventory,['data','nextCursor']),
  unexpectedServerFieldCount:extras(server,serverFields),stopReason:null,
 };
 // Preserve the existing guard order and admission policy. Missing/nullable
 // status fields remain observations, not new auth failures or new permissions.
 let reason=null;
 if(inventory==null)reason='DISCOVERY_RESPONSE_MISSING';
 else if(!object(inventory))reason='DISCOVERY_RESPONSE_INVALID';
 else if(data==null)reason='DISCOVERY_DATA_MISSING';
 else if(!Array.isArray(data))reason='DISCOVERY_DATA_INVALID';
 else if(data.some(s=>s==null))reason='DISCOVERY_SERVER_ENTRY_INVALID';
 else if(!servers.length)reason='DISCOVERY_SERVER_MISSING';
 else if(servers.length!==1)reason='DISCOVERY_SERVER_DUPLICATE';
 else if(inventory.nextCursor)reason='DISCOVERY_PAGINATION_INCOMPLETE';
 else if(server.toolsError)reason='DISCOVERY_TOOLS_ERROR';
 else if(server.authStatus==='notLoggedIn')reason='DISCOVERY_AUTH_NOT_LOGGED_IN';
 else if(server.runtimeStatus&&server.runtimeStatus!=='connected')reason=server.runtimeStatus==='starting'?'DISCOVERY_RUNTIME_STARTING':'DISCOVERY_RUNTIME_NOT_CONNECTED';
 else if(invalidTools)reason='DISCOVERY_TOOL_ENTRY_INVALID';
 else if(matches.length!==1)reason='EXACT_TOOL_UNAVAILABLE';
 evidence.stopReason=reason;
 return {evidence,tool:reason?null:matches[0]};
}

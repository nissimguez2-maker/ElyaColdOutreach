import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

// In-process offline test guard, including native subprocess escape routes.
// Not an OS firewall or protection against hostile native code.
export function blockNetwork(t){
 let attempts=0;
 const deny=()=>{attempts++;throw Error('OFFLINE_NETWORK_BLOCKED');};
 t.mock.method(globalThis,'fetch',deny);
 for(const [object,names]of [[http,['get','request']],[https,['get','request']],
  [net,['connect','createConnection']],[net.Socket.prototype,['connect']],
  [tls,['connect']],[dgram,['createSocket']],
  [dns,['lookup','resolve','resolveMx','resolve4','resolve6']],
  [dnsPromises,['lookup','resolve','resolveMx','resolve4','resolve6']],
  [childProcess,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]]){
  for(const name of names)t.mock.method(object,name,deny);
 }
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 return {get attempts(){return attempts;}};
}

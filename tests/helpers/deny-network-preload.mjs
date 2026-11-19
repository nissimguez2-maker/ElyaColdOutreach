import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';

// Full-suite offline guard. Inherited by Node children through NODE_OPTIONS.
// Harmless local fixture processes remain allowed; this is not an OS firewall.
const deny=()=>{throw Error('OFFLINE_SUITE_NETWORK_BLOCKED');};
globalThis.fetch=deny;
for(const [object,names]of [[http,['get','request']],[https,['get','request']],
 [net,['connect','createConnection']],[net.Socket.prototype,['connect']],
 [tls,['connect']],[dgram,['createSocket']],
 [dns,['lookup','resolve','resolveMx','resolve4','resolve6']],
 [dnsPromises,['lookup','resolve','resolveMx','resolve4','resolve6']]]){
 for(const name of names)object[name]=deny;
}
syncBuiltinESMExports();

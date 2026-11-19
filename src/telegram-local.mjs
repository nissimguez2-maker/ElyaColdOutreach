/** Raw-mode input prevents terminal echo and shell-history capture. No transcript. */
export function createLocalPrompt(input=process.stdin,output=process.stdout){
 if(!input.isTTY||!output.isTTY||typeof input.setRawMode!=='function')throw Error('LOCAL_TERMINAL_REQUIRED');
 return (prompt,{masked=false,ms=300000}={})=>new Promise((resolve,reject)=>{
  let value='',done=false;const wasRaw=!!input.isRaw;
  const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);input.removeListener('data',data);input.setRawMode(wasRaw);input.pause();output.write('\n');if(error)reject(Error(error));else resolve(value);value='';};
  const data=chunk=>{for(const c of chunk.toString('utf8')){if(done)break;if(c==='\u0003'){finish('LOCAL_CANCELLED');break;}if(c==='\r'||c==='\n'){finish();break;}if(c==='\u007f'||c==='\b'){if(value.length){value=value.slice(0,-1);output.write('\b \b');}continue;}if(c>=' '&&c<='~'){if(value.length>=1024){finish('LOCAL_INPUT_TOO_LONG');break;}value+=c;output.write(masked?'*':c);}}};
  const timer=setTimeout(()=>finish('LOCAL_INPUT_TIMEOUT'),Math.max(1,ms));output.write(prompt+' ');input.setRawMode(true);input.on('data',data);input.resume();
 });
}

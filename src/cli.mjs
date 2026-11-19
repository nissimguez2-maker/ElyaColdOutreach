import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, controls, setStopped, recoverOperations, backupStore, restoreStore, budgetStatus, canonical, now } from './foundation.mjs';
import { importProject, recordCounts } from './import.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const dbOption = args.indexOf('--db'); let database = resolve(root, 'data/elya.sqlite');
if (dbOption !== -1) {
  if (!args[dbOption + 1]) { console.error('--db requires a path'); process.exit(1); }
  database = resolve(args[dbOption + 1]); args.splice(dbOption, 2);
}
const [command, ...rest] = args;
let db;
try {
  let result;
  if (command === 'restore') {
    if (rest.length !== 2) throw new Error('Usage: restore BACKUP NEW_DATABASE');
    await restoreStore(resolve(rest[0]), resolve(rest[1])); result = { restored: resolve(rest[1]), stopped: true, launchAuthorized: false };
  } else {
    if (!['import','status','stop','recover','backup','export','refine','review-writing'].includes(command)) throw new Error('Commands: import | status | stop | recover | backup NEW_FILE | restore BACKUP NEW_DATABASE | export NEW_FILE | refine --as-of TIMESTAMP | review-writing --as-of TIMESTAMP; optional --db PATH');
    if (!existsSync(database) && command !== 'import') throw new Error('Database does not exist; run import first');
    db = openStore(database);
    if (command === 'import') result = importProject(db, root);
    if (command === 'review-writing') {
      if(rest.length!==2||rest[0]!=='--as-of')throw Error('Usage: review-writing --as-of TIMESTAMP; optional --db PATH');
      const {prepareSavedWritingReviews}=await import('./writing-saved.mjs'),{renderWritingReview,evaluateWritingReview}=await import('./writing.mjs');
      const prepared=prepareSavedWritingReviews(db,rest[1]),directory=resolve(root,'work/writing/reviews');mkdirSync(directory,{recursive:true});
      const packets=prepared.packets.map(packet=>{
        const artifacts=[];
        for(const [extension,content]of [['json',JSON.stringify(packet,null,2)],['md',renderWritingReview(packet)]]){
          const path=resolve(directory,packet.hash+'.'+extension);
          if(existsSync(path)){if(readFileSync(path,'utf8')!==content)throw Error('Existing writing artifact differs; retained for review');}
          else writeFileSync(path,content,{flag:'wx'});
          artifacts.push(path);
        }
        return {reviewId:packet.reviewId,packetHash:packet.hash,version:packet.version,...evaluateWritingReview(db,packet.reviewId,null,rest[1]),artifacts};
      });
      result={policyRevision:prepared.policyRevision,packets,controls:controls(db),liveCalls:0,generalLiveDispatchEnabled:false};
    }
    if (command === 'refine') {
      if(rest.length!==2||rest[0]!=='--as-of')throw Error('Usage: refine --as-of TIMESTAMP; optional --db PATH');
      const {loadSavedRefinement}=await import('./refinement-saved.mjs'),{processRefinement,renderRefinementReview}=await import('./refinement-store.mjs'),{PHILADELPHIA_POLICY}=await import('./refinement-policy.mjs');
      const assessment=processRefinement(db,loadSavedRefinement(db),PHILADELPHIA_POLICY,rest[1]);
      const directory=resolve(root,'work/refinement/reviews');mkdirSync(directory,{recursive:true});
      const artifacts=[];
      for(const [extension,content]of [['json',JSON.stringify(assessment,null,2)],['md',renderRefinementReview(assessment)]]){
        const path=resolve(directory,assessment.semanticHash+'.'+extension);
        if(existsSync(path)){if(readFileSync(path,'utf8')!==content)throw Error('Existing refinement artifact differs; retained for review');}
        else writeFileSync(path,content,{flag:'wx'});
        artifacts.push(path);
      }
      result={semanticHash:assessment.semanticHash,policyRevision:assessment.policyRevision,asOf:assessment.asOf,businesses:assessment.assessments.length,businessFitPassed:assessment.assessments.filter(a=>a.businessFit.state==='PASS').length,qualifiedForReview:assessment.assessments.filter(a=>a.disposition==='QUALIFIED_FOR_REVIEW').length,held:assessment.assessments.filter(a=>a.disposition==='HOLD').length,rejected:assessment.assessments.filter(a=>a.disposition==='REJECT').length,proposedTasks:assessment.tasks.length,artifacts,controls:controls(db),generalLiveDispatchEnabled:false,liveCalls:0};
    }
    if (command === 'status') result = {
      database, controls: controls(db), counts: recordCounts(db),
      budgets: Object.fromEntries(db.prepare('SELECT id FROM budgets').all().map(r => [r.id, budgetStatus(db, r.id)])),
      reconciliation: db.prepare("SELECT id,status,remote_id,reservation_usd,actual_usd FROM operations WHERE status IN ('DISPATCHING','RECONCILIATION')").all(),
      liveTransport: 'NOT_IMPLEMENTED'
    };
    if (command === 'stop') { setStopped(db, true, 'Local CLI stop'); result = controls(db); }
    if (command === 'recover') result = recoverOperations(db);
    if (command === 'backup') {
      if (rest.length !== 1) throw new Error('Usage: backup NEW_FILE');
      result = await backupStore(db, resolve(rest[0]));
    }
    if (command === 'export') {
      if (rest.length !== 1) throw new Error('Usage: export NEW_FILE');
      const snapshot = { authority: 'Snapshot export; SQLite remains authoritative', exportedAt: now(), controls: controls(db),
        sources: db.prepare('SELECT id,path,sha256 FROM sources ORDER BY id').all().map(r => ({ ...r })),
        records: db.prepare('SELECT * FROM records ORDER BY kind,id').all().map(r => ({ ...r, data: JSON.parse(r.data_json), data_json: null })) };
      canonical(snapshot); writeFileSync(resolve(rest[0]), JSON.stringify(snapshot, null, 2), { flag: 'wx' });
      result = { exported: resolve(rest[0]), records: snapshot.records.length };
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Our errors omit input values. Native errors may include paths but no source payloads.
  console.error(error.message); process.exitCode = 1;
} finally { db?.close(); }

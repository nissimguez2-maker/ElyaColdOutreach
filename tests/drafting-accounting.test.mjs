import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createBudget,reserveOperation,beginOperation,recordOutcome} from '../src/operations.mjs';
import {controls} from '../src/store.mjs';

const module=await import('../src/drafting-accounting.mjs').catch(()=>null);
function legacy(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8').replace("'READ','DRAFT'","'READ'"));return db;}
function historical(db){createBudget(db,'test','1','0','0');reserveOperation(db,{id:'old',kind:'VERIFY',budgetId:'test',reservation:'0.15',authorizationRef:'fixture',payload:{email:'held@example.invalid'}});beginOperation(db,'old');recordOutcome(db,'old',{status:'AMBIGUOUS',actual:null,evidence:'fixture uncertainty'});}
test('legacy drafting-accounting preview is read-only and exact confirmation is required',()=>{
 assert.ok(module,'explicit drafting schema preview/migration boundary required');
 const db=legacy();try{historical(db);const before=db.prepare('SELECT * FROM operations').all(),p=module.previewDraftingAccountingUpgrade(db);
 assert.equal(p.required,true);assert.equal(p.operationCount,1);
 assert.throws(()=>module.applyDraftingAccountingUpgrade(db,{confirmedHash:'wrong',actor:'fixture operator'}),/CONFIRMATION/);
 assert.deepEqual(db.prepare('SELECT * FROM operations').all(),before);
 const result=module.applyDraftingAccountingUpgrade(db,{confirmedHash:p.hash,actor:'fixture operator'});
 assert.equal(result.status,'APPLIED');assert.deepEqual(db.prepare('SELECT * FROM operations').all(),before);
 assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);
 assert.equal(module.previewDraftingAccountingUpgrade(db).required,false);
 assert.throws(()=>reserveOperation(db,{id:'new',kind:'DRAFT',budgetId:'test',reservation:'0.1',authorizationRef:'fixture',payload:{stage:'generation'}}),/reconciliation/);
 }finally{db.close();}
});
test('changed accounting preview or running operation refuses schema application',()=>{
 assert.ok(module);const db=legacy();try{createBudget(db,'test','1','0','0');const p=module.previewDraftingAccountingUpgrade(db);
 reserveOperation(db,{id:'new',kind:'READ',budgetId:'test',reservation:'0',authorizationRef:'fixture',payload:{target:'synthetic'}});
 assert.throws(()=>module.applyDraftingAccountingUpgrade(db,{confirmedHash:p.hash,actor:'fixture operator'}),/CONFIRMATION/);
 beginOperation(db,'new');assert.throws(()=>module.previewDraftingAccountingUpgrade(db),/ACTIVE_OPERATION/);
 }finally{db.close();}
});
test('new database DRAFT operations use existing exact reservations, reconciliation and no-replay controls',()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
 try{createBudget(db,'draft','1','0','0');reserveOperation(db,{id:'draft-one',kind:'DRAFT',budgetId:'draft',reservation:'0.25',authorizationRef:'fixture',payload:{packetHash:'fixture',stage:'generation'}});
 beginOperation(db,'draft-one');recordOutcome(db,'draft-one',{status:'AMBIGUOUS',actual:null,evidence:'fixture model timeout'});
 const row=db.prepare('SELECT * FROM operations').get();assert.equal(row.reservation_usd,'0.25');assert.equal(row.status,'RECONCILIATION');
 assert.throws(()=>beginOperation(db,'draft-one'),/reconciliation|terminal/);
 }finally{db.close();}
});

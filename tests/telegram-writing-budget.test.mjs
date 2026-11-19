import test from 'node:test';import assert from 'node:assert/strict';
import {blockNetwork} from './helpers/network-block.mjs';
test('shared budget reserves callback/details and final stop poll; no replenishment',async t=>{
 blockNetwork(t);const {WritingRequestBudget}=await import('../src/telegram-writing-budget.mjs');let clock=0;const writes=[];
 const b=new WritingRequestBudget({clock:()=>clock,record:s=>writes.push(s)});
 b.take('getMe');b.take('getWebhookInfo');for(let i=0;i<4;i++)b.take('initialMessages');
 for(let i=0;i<11;i++)b.take('polls');assert.throws(()=>b.take('polls'),/STOP_POLL_RESERVED/);
 b.requireAction('DETAILS');b.take('acknowledgments');b.take('detailsMessages');
 for(let i=0;i<4;i++){b.requireAction('APPROVED');b.take('acknowledgments');}
 b.take('polls',{stopPhase:true});assert.equal(b.snapshot().attempts,24);assert.throws(()=>b.take('polls',{stopPhase:true}),/BUDGET/);assert.equal(writes.length,24);
});
test('action must have both slots and time before a decision; stop prevents all later I/O',async t=>{
 blockNetwork(t);const {WritingRequestBudget}=await import('../src/telegram-writing-budget.mjs');let clock=0;const b=new WritingRequestBudget({clock:()=>clock,record:()=>{}});
 clock=161000;assert.throws(()=>b.requireAction('DETAILS'),/TIME/);clock=166000;assert.throws(()=>b.requireAction('APPROVED'),/TIME/);
 clock=170000;assert.throws(()=>b.take('polls'),/DEADLINE/);clock=0;b.stop();assert.throws(()=>b.take('getMe'),/STOPPED/);
});
test('attempt persists before dispatch and a failed attempt is never refunded',async t=>{
 blockNetwork(t);const {WritingRequestBudget}=await import('../src/telegram-writing-budget.mjs');let clock=0;const b=new WritingRequestBudget({clock:()=>clock,record:()=>{}});
 b.take('getMe');assert.throws(()=>b.take('getMe'),/BUDGET/);assert.equal(b.snapshot().attempts,1);
});
test('timeout is recomputed after slow durable intent persistence',async t=>{
 blockNetwork(t);const {WritingRequestBudget}=await import('../src/telegram-writing-budget.mjs');let clock=0;const b=new WritingRequestBudget({clock:()=>clock,record:()=>{clock+=5000;}});
 clock=158000;assert.equal(b.take('polls'),7000);
});

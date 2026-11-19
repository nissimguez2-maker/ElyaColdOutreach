// Exact user-approved scope. This is not a generic outbound-message interface.
export const APPROVED_CHAT_ID=8473827686;
export const APPROVED_USER_ID=8473827686;
export const APPROVED_BATCH_ID='QA-TG-01';
export const APPROVED_HASHES=Object.freeze([
 '4a2f30a073cb72d5065e25b8ee03ac56c9a1c33be2ab7f238a65bc61d7306660',
 '03ab438ee8e390d6dc2331d72e4f12a6e031c2546611562e176ab2ba875fa94c'
]);
export const APPROVED_PACKETS=Object.freeze(APPROVED_HASHES.map((hash,index)=>{
 const v=index+1;
 return `SYNTHETIC QA ONLY — decision test\nBatch: QA-TG-01\nVersion: ${v}\nSHA-256: ${hash}\nRecipient: qa@example.invalid (not deliverable)\nSubject: Synthetic QA revision ${v}\nBody: Synthetic message revision ${v}. No outreach is authorized.\nApprove: /approve qa-tg-01-v${v}\nReject: /reject qa-tg-01-v${v}\nStop: /stop\nDecision only. Business remains stopped; launch is not authorized.`;
}));

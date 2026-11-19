// In-process capability for the fixed workflow composition; never serialized.
// This is not a security boundary against a party able to edit trusted code.
const bindings=new WeakMap();
export function bindWorkflowHandler(db,jobId,handler,assertBoundary){
 bindings.set(handler,{db,jobId,assertBoundary});return Object.freeze(handler);
}
export function workflowHandlerBoundary(db,jobId,handler){
 const bound=bindings.get(handler);
 if(!bound||bound.db!==db||bound.jobId!==jobId)throw Error('WORKFLOW_FIXED_HANDLER_REQUIRED');
 return bound.assertBoundary;
}

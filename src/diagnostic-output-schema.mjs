// Deliberately bounded JSON Schema subset; unknown assertions fail pre-dispatch.
// No external refs, downloads, code generation, coercion or added dependencies.
import {isDeepStrictEqual} from 'node:util';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export const schemaTypes=Object.freeze(['object','array','string','integer','number','boolean','null']);
const annotations=['title','description','$id'];
const keys=[...annotations,'$schema','type','properties','propertyNames','required','additionalProperties','items','enum','const','minimum','maximum','minLength','maxLength','minItems','maxItems','pattern','format'];
export const schemaPath=(parent,key)=>`${parent}/${String(key).replace(/~/g,'~0').replace(/\//g,'~1')}`;
export function schemaValidationError(context,{path,keyword,value,category,rule,reason}){
 const side=context.side??'output';
 // Keep the original code for legacy output-only callers; the acceptance route
 // supplies tool/side and receives a distinct code and structured diagnostic.
 const error=Error(context.tool?`INSTANTLY_${side.toUpperCase()}_SCHEMA_${category}`:'OUTPUT_SCHEMA_UNSUPPORTED');
 error.schemaFailure={tool:context.tool??null,side,path,keyword,category,observedType:value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value,rule,reason};
 return error;
}
export function prepareOutputSchema(schema,context={}){
 let nodes=0;
 const root=context.side==='input'?'/inputSchema':'/outputSchema';
 const fail=(path,keyword,value,category,rule,reason)=>{throw schemaValidationError(context,{path,keyword,value,category,rule,reason});};
 function visit(s,depth=0,path=root,keyword=root.slice(1)){
  if(s===undefined)fail(path,keyword,s,'ABSENT','SCHEMA_REQUIRED','A schema is required at this location.');
  if(!object(s))fail(path,keyword,s,typeof s==='boolean'?'UNSUPPORTED':'MALFORMED','OBJECT_SCHEMA_REQUIRED','Only object-form schemas are supported; boolean schemas are not implemented.');
  if(++nodes>500||depth>12)fail(path,keyword,s,'UNSUPPORTED','SCHEMA_COMPLEXITY_LIMIT','Schema exceeds the 500-node or 12-level validation bound.');
  for(const k of Object.keys(s))if(!keys.includes(k))fail(schemaPath(path,k),k,s[k],'UNSUPPORTED','KEYWORD_NOT_IMPLEMENTED','This keyword is outside the enforced schema subset.');
  for(const k of annotations)if(k in s&&typeof s[k]!=='string')fail(schemaPath(path,k),k,s[k],'MALFORMED','ANNOTATION_STRING_REQUIRED','Annotation must be a string.');
  if('$schema'in s){
   if(typeof s.$schema!=='string')fail(schemaPath(path,'$schema'),'$schema',s.$schema,'MALFORMED','DIALECT_STRING_REQUIRED','Schema dialect must be a string.');
   if(!['http://json-schema.org/draft-07/schema#','https://json-schema.org/draft/2020-12/schema'].includes(s.$schema))fail(schemaPath(path,'$schema'),'$schema',s.$schema,'UNSUPPORTED','DIALECT_NOT_IMPLEMENTED','Only the explicitly supported draft-07 and 2020-12 dialect identifiers are accepted.');
  }
  if('type'in s&&!(typeof s.type==='string'?schemaTypes.includes(s.type):Array.isArray(s.type)&&s.type.length>0&&s.type.every(t=>schemaTypes.includes(t))))fail(schemaPath(path,'type'),'type',s.type,'MALFORMED','SCHEMA_TYPE_INVALID','Type must name a JSON Schema primitive or a nonempty array of those names.');
  if('properties'in s){if(!object(s.properties))fail(schemaPath(path,'properties'),'properties',s.properties,'MALFORMED','PROPERTIES_OBJECT_REQUIRED','Properties must be an object mapping names to schemas.');for(const [k,child]of Object.entries(s.properties))visit(child,depth+1,schemaPath(schemaPath(path,'properties'),k),k);}
  if('required'in s&&(!Array.isArray(s.required)||!s.required.every(k=>typeof k==='string')||new Set(s.required).size!==s.required.length))fail(schemaPath(path,'required'),'required',s.required,'MALFORMED','REQUIRED_UNIQUE_STRINGS','Required must be an array of distinct string property names.');
  if('additionalProperties'in s&&typeof s.additionalProperties!=='boolean')visit(s.additionalProperties,depth+1,schemaPath(path,'additionalProperties'),'additionalProperties');
  for(const k of ['items','propertyNames'])if(k in s)visit(s[k],depth+1,schemaPath(path,k),k);
  if('enum'in s&&(!Array.isArray(s.enum)||!s.enum.length))fail(schemaPath(path,'enum'),'enum',s.enum,'MALFORMED','ENUM_NONEMPTY_ARRAY','Enum must be a nonempty array.');
  for(const k of ['minimum','maximum'])if(k in s&&(typeof s[k]!=='number'||!Number.isFinite(s[k])))fail(schemaPath(path,k),k,s[k],'MALFORMED','FINITE_NUMBER_REQUIRED','Numeric bound must be a finite number.');
  for(const k of ['minLength','maxLength','minItems','maxItems'])if(k in s&&(!Number.isSafeInteger(s[k])||s[k]<0))fail(schemaPath(path,k),k,s[k],'MALFORMED','NONNEGATIVE_INTEGER_REQUIRED','Length/count bound must be a nonnegative safe integer.');
  if('pattern'in s){
   if(typeof s.pattern!=='string')fail(schemaPath(path,'pattern'),'pattern',s.pattern,'MALFORMED','PATTERN_STRING_REQUIRED','Pattern must be a string.');
   if(s.pattern.length>512)fail(schemaPath(path,'pattern'),'pattern',s.pattern,'UNSUPPORTED','PATTERN_LENGTH_LIMIT','Patterns longer than 512 characters are not supported.');
   try{new RegExp(s.pattern,'u');}catch{fail(schemaPath(path,'pattern'),'pattern',s.pattern,'MALFORMED','PATTERN_INVALID','Pattern must compile as a Unicode regular expression.');}
  }
  if('format'in s&&s.format!=='uuid')fail(schemaPath(path,'format'),'format',s.format,typeof s.format==='string'?'UNSUPPORTED':'MALFORMED','FORMAT_NOT_IMPLEMENTED','Only the uuid string format is enforced.');
 }
 visit(schema);if(schema.type!=='object')fail(schemaPath(root,'type'),'type',schema.type,'UNSUPPORTED','ROOT_OBJECT_REQUIRED','The application requires an explicit object root schema.');return schema;
}
const matches=(type,v)=>type==='null'?v===null:type==='object'?object(v):type==='array'?Array.isArray(v):type==='integer'?Number.isSafeInteger(v):type==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===type;
export function checkOutputSchema(schema,value){
 function valid(s,v){
  if(s.type&&!(Array.isArray(s.type)?s.type:[s.type]).some(t=>matches(t,v)))return false;
  if(s.enum&&!s.enum.some(x=>isDeepStrictEqual(x,v))||'const'in s&&!isDeepStrictEqual(s.const,v))return false;
  if(typeof v==='number'&&(s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum))return false;
  if(typeof v==='string'){
   const length=Array.from(v).length;
   if(s.minLength!==undefined&&length<s.minLength||s.maxLength!==undefined&&length>s.maxLength||s.pattern&&!new RegExp(s.pattern,'u').test(v))return false;
   if(s.format==='uuid'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))return false;
  }
  if(Array.isArray(v)){if(s.minItems!==undefined&&v.length<s.minItems||s.maxItems!==undefined&&v.length>s.maxItems)return false;if(s.items&&!v.every(x=>valid(s.items,x)))return false;}
  if(object(v)){
   if(s.propertyNames&&!Object.keys(v).every(k=>valid(s.propertyNames,k)))return false;
   if(s.required?.some(k=>!Object.hasOwn(v,k)))return false;
   for(const [k,x]of Object.entries(v)){if(Object.hasOwn(s.properties??{},k)){if(!valid(s.properties[k],x))return false;}else if(s.additionalProperties===false)return false;else if(object(s.additionalProperties)&&!valid(s.additionalProperties,x))return false;}
  }
  return true;
 }
 return valid(schema,value);
}

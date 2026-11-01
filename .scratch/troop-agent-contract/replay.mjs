// Controlled evidence only: real reconstructed Agent + fake model stream/tool.
// Run at repository root. No provider, credential, application profile or shell use.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const scratch=path.resolve('.tmp-agent-contract');
await mkdir(scratch,{recursive:true});
await build({stdin:{contents:`
export { AnysphereAgent } from './source/packages/agent/index.ts';
export { SimplePromptToolExecutor } from './source/packages/agent/tool-stream-executor.ts';
export { ToolSetHandle } from './source/packages/agent/tools/core.ts';
export { InMemoryBlobStore } from './source/packages/agent-kv/blob-store.ts';
export { createContext } from './source/packages/context/core.ts';
export { PrivacyMode } from './source/packages/redaction/privacy-mode.ts';
export * as P from './source/packages/proto/generated/agent/v1/agent_pb.ts';
export * as ReadP from './source/packages/proto/generated/agent/v1/read_tool_pb.ts';
export { RequestContext } from './source/packages/proto/generated/agent/v1/request_context_exec_pb.ts';
export { toRedactedConversationStateStructure, toRedactedConversationAction } from './source/packages/redacted-protos/generated/agent/v1/agent_redacted.ts';
export { createRunStreamStateUpdateWithFlush } from './source/packages/agent/run-stream-lifecycle.ts';
`,resolveDir:process.cwd(),loader:'ts'},outfile:path.join(scratch,'runtime.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',logLevel:'warning'});
globalThis.fetch=async()=>{throw new Error('Network disabled in controlled replay');};
const R=await import(pathToFileURL(path.join(scratch,'runtime.mjs')).href);
const all=[];
for(const scenario of ['text','tool-loop','tool-wait','tool-cancel']){
 const trace=[];const note=(event,details={})=>trace.push({seq:trace.length+1,event,...details});
 const [ctx,cancel]=R.createContext().withName('synthetic-replay').withCancel();
 let messages=[],step=0;
 const base={appendMessages(items){messages.push(...items);note('append',{roles:items.map(x=>x.role)});},getState(){return messages;},getMessages(){return messages;},clearMessages(){messages=[];},stream(streamCtx,id){
   const call=step++===0&&scenario!=='text';
   const content=call?[{type:'tool-call',toolCallId:'synthetic-call-1',toolName:'probe',args:{value:'synthetic'}}]:[{type:'text',text:'Synthetic completion'}];
   note('model-request',{step,call});
   return {fullStream:(async function*(){for(const p of content){if(streamCtx.signal.aborted)throw new Error('synthetic model aborted');yield p.type==='text'?{type:'text-delta',textDelta:p.text}:p;}})(),response:Promise.resolve({id,messages:[{role:'assistant',content}],timestamp:new Date(0),modelId:'replay'}),usage:Promise.resolve({totalTokens:10,promptTokens:5,completionTokens:5}),extendedUsage:Promise.resolve({inputTokens:5,outputTokens:5,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,maxTokens:100000}),providerMetadata:Promise.resolve({}),invocationId:id};
 }};
 const tool={name:'probe',toolIdentifier:'READ',description:'Artificial probe: no filesystem or external effects',parameters:{type:'object',properties:{value:{type:'string'}}},
  async execute(toolCtx,_interaction,args,meta){note('tool-start',{id:meta.toolCallId});for await(const chunk of args)note('tool-args',{chunk});
   if(scenario==='tool-wait') {note('tool-wait');await new Promise(resolve=>setTimeout(resolve,20));note('tool-release');}
   if(scenario==='tool-cancel'){note('tool-wait');await new Promise((resolve,reject)=>{const onAbort=()=>{note('tool-abort-observed');reject(new Error('synthetic tool cancelled'));};if(toolCtx.signal.aborted)onAbort();else toolCtx.signal.addEventListener('abort',onAbort,{once:true});setTimeout(()=>{note('cancel-request');cancel({intentional:true,reason:'synthetic stop'});},20);});}
   note('tool-result');return new R.ReadP.ReadToolResult({result:{case:'success',value:new R.ReadP.ReadToolSuccess({path:'synthetic',output:{case:'content',value:'synthetic'}})}});},
  async render(){return {content:[{type:'text',text:'synthetic tool result'}]};},
  serializeError(error){return new R.P.ToolCall({tool:{case:'readToolCall',value:new R.ReadP.ReadToolCall({result:new R.ReadP.ReadToolResult({result:{case:'error',value:new R.ReadP.ReadToolError({errorMessage:String(error)})}})})}});}
 };
 const blob=new R.InMemoryBlobStore();const originalFlush=blob.flush.bind(blob);blob.flush=async c=>{note('blob-flush');await originalFlush(c);};
 const listener={async sendUpdate(_c,u){note('update',{kind:u.update?.case??u.case??'unknown'});},async query(){throw new Error('Unexpected interaction query in offline replay');}};
 const resourceAccessor={get(resource){throw new Error('External resource blocked: '+String(resource?.name??resource));}};
 const config={modelId:'replay',agentTokenLimit:100000,maxSteps:4,systemPromptGenerator:()=> 'Synthetic replay only',toolsGenerator:()=>R.ToolSetHandle.fromTools([tool]),userInfoDisplayOptions:{disable:true},featureFlags:{},smartModeClassifierMode:false,smartModeClassifierShadowMode:false,enableTerminalFiles:false,enableImageFiles:false,immediatelyUpdateStateOnNewTurn:true,fireAndForgetCheckpoints:false};
 const agent=new R.AnysphereAgent(config,{getExecutor:()=>new R.SimplePromptToolExecutor(base)},listener,resourceAccessor,blob,{}, {peek:async()=>undefined,pop:async()=>undefined});
 const action=new R.P.ConversationAction({action:{case:'userMessageAction',value:new R.P.UserMessageAction({userMessage:new R.P.UserMessage({text:'synthetic input',messageId:'synthetic-message',mode:R.P.AgentMode.AGENT??1}),requestContext:new R.RequestContext()})}});
 let outcome;
 try{
  const result=await agent.runStream(ctx,R.toRedactedConversationStateStructure(new R.P.ConversationStateStructure(),R.PrivacyMode.UNSPECIFIED),R.toRedactedConversationAction(action,R.PrivacyMode.UNSPECIFIED),[],async(_c,state)=>note('checkpoint-callback',{turns:state.turns?.length,pending:state.pendingToolCalls?.length}));
  outcome={returned:true,keys:Object.keys(result??{}),cancelledContext:ctx.canceled};
 }catch(error){outcome={returned:false,error:String(error),cancelledContext:ctx.canceled};}
 all.push({scenario,outcome,trace});
 console.log(JSON.stringify({scenario,outcome,events:trace.map(x=>x.event)}));
}
const checkpointTrace=[];
const callback=R.createRunStreamStateUpdateWithFlush({blobStore:{async flush(){checkpointTrace.push('flush-failed');throw new Error('synthetic storage failure');}},async onStateUpdate(){checkpointTrace.push('checkpoint-callback');}});
await callback(R.createContext(),R.toRedactedConversationStateStructure(new R.P.ConversationStateStructure(),R.PrivacyMode.UNSPECIFIED));
checkpointTrace.push('caller-returned-without-error');
for(const item of all){
 const events=item.trace.map(x=>x.event);
 const modelSteps=events.filter(x=>x==='model-request').length;
 assert.ok(events.includes('checkpoint-callback'),item.scenario+' checkpoint');
 if(item.scenario==='tool-cancel'){
  assert.equal(item.outcome.returned,false);
  assert.equal(item.outcome.cancelledContext,true);
  assert.match(item.outcome.error,/\[canceled\]/);
  assert.ok(events.includes('tool-abort-observed'));
  assert.equal(modelSteps,1);
  assert.ok(!events.includes('tool-result'));
 }else{
  assert.equal(item.outcome.returned,true,item.scenario+' returned');
  assert.equal(modelSteps,item.scenario==='text'?1:2);
  if(item.scenario!=='text')assert.ok(events.includes('tool-result'));
  if(item.scenario==='tool-wait')assert.ok(events.indexOf('tool-release')>events.indexOf('tool-wait'));
 }
}
assert.deepEqual(checkpointTrace,['flush-failed','caller-returned-without-error']);
const result={scope:'Actual AnysphereAgent and SimplePromptToolExecutor; synthetic provider/tool; memory-only, not production recovery',node:process.version,checksPassed:true,scenarios:all,checkpointFailure:checkpointTrace};
await writeFile('.scratch/troop-agent-contract/replay-results.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({checkpointFailure:checkpointTrace}));

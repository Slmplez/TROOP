// Run from the reconstructed repository root with Node 26.5.0.
// Synthetic data only. No application profile, provider, shell tool or network access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { extractAsarFile as extractFile } from '../../../scripts/lib/asar-paths.mjs';

const out = path.resolve('.tmp-baseline');
await mkdir(out, { recursive: true });
await build({
  stdin: { contents: `
    export * as P from './source/packages/proto/generated/agent/v1/agent_pb.ts';
    export * as S from './source/packages/proto/generated/agent/v1/selected_context_pb.ts';
    export * as R from './source/packages/proto/generated/agent/v1/read_tool_pb.ts';
    export { AgentStore2 } from './source/packages/agent-kv/agent-store.ts';
    export { getBlobId } from './source/packages/agent-kv/blob-store.ts';
    export { resolveSubagentPersistedStates } from './source/packages/agent-kv/subagent-states.ts';
    export { createContext } from './source/packages/context/core.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(out, 'codec.mjs'), bundle: true, platform: 'node',
  format: 'esm', packages: 'external', logLevel: 'warning',
});
const { P, S, R, AgentStore2, getBlobId, resolveSubagentPersistedStates, createContext } =
  await import(pathToFileURL(path.join(out, 'codec.mjs')).href);
const ctx = createContext();
const hex = bytes => Buffer.from(bytes).toString('hex');
const results = [];
const fixtures = [];

for (const kind of ['plain-chat', 'tool-attachment-summary', 'subagent-incomplete']) {
  const blobs = new Map();
  const trace = [];
  const store = {
    async getBlob(_ctx, id) { trace.push({ operation: 'get', id: hex(id), found: blobs.has(hex(id)) }); return blobs.get(hex(id)); },
    async setBlob(_ctx, id, bytes) { blobs.set(hex(id), bytes); trace.push({ operation: 'set', id: hex(id), bytes: bytes.length }); },
    async flush() {},
  };
  const put = async value => {
    const bytes = value instanceof Uint8Array ? value : value.toBinary();
    const id = await getBlobId(bytes);
    await store.setBlob(ctx, id, bytes);
    return id;
  };
  const attachment = kind === 'tool-attachment-summary'
    ? await put(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>'))
    : undefined;
  const user = new P.UserMessage({ text: `Synthetic ${kind}`, messageId: `fixture-${kind}`,
    ...(attachment ? { selectedContext: new S.SelectedContext({ selectedImages: [new S.SelectedImage({
      uuid: 'synthetic-image', path: 'fixture.svg', mimeType: 'image/svg+xml', dataOrBlobId: { case: 'blobId', value: attachment },
    })] }) } : {}),
  });
  const step = kind === 'tool-attachment-summary'
    ? new P.ConversationStep({ message: { case: 'toolCall', value: new P.ToolCall({
      toolCallId: 'synthetic-read', startedAtMs: 1n, completedAtMs: 2n,
      tool: { case: 'readToolCall', value: new R.ReadToolCall({ args: new R.ReadToolArgs({ path: 'fixture.txt' }),
        result: new R.ReadToolResult({ result: { case: 'success', value: new R.ReadToolSuccess({ path: 'fixture.txt', totalLines: 1, fileSize: 7, output: { case: 'content', value: 'fixture' } }) } }),
      }) },
    }) } })
    : new P.ConversationStep({ message: { case: 'assistantMessage', value: new P.AssistantMessage({ text: 'Synthetic reply' }) } });
  const userId = await put(user);
  const stepId = await put(step);
  const turnId = await put(new P.ConversationTurnStructure({ turn: { case: 'agentConversationTurn', value: new P.AgentConversationTurnStructure({
    userMessage: userId, steps: [stepId], requestId: 'synthetic-request',
  }) } }));
  const structure = new P.ConversationStateStructure({ turns: [turnId] });
  if (attachment) structure.summary = await put(new P.ConversationSummary({ summary: 'Synthetic summary' }));
  let childId;
  if (kind === 'subagent-incomplete') {
    structure.pendingToolCalls = ['synthetic-unfinished-tool'];
    childId = await put(new P.SubagentPersistedState({ conversationState: new P.ConversationStateStructure({ turns: [turnId] }), createdTimestampMs: 1n, lastUsedTimestampMs: 2n }));
    structure.subagentStateRefs = { 'synthetic-child': childId };
  }
  const metadata = { agentId: `synthetic-${kind}`, latestRootBlobId: new Uint8Array() };
  const metadataStore = { get: key => metadata[key], set: (key, value) => { metadata[key] = value; }, subscribe: () => () => {} };
  const writer = new AgentStore2(store, metadataStore);
  await writer.handleCheckpoint(ctx, structure);
  const reader = new AgentStore2(store, metadataStore);
  assert.equal(await reader.tryResetFromDb(ctx), true);
  const restored = await reader.getFullConversationWithSubagents(ctx);
  const restoredTurn = restored.conversationState.turns[0].turn.value;
  assert.equal(restoredTurn.userMessage.text, user.text);
  assert.equal(restoredTurn.steps.length, 1);
  assert.equal(await reader.getLastRequestIdFromConversation(ctx), 'synthetic-request');
  // Record complete original fixture graph before deliberate missing-blob probes.
  fixtures.push({ kind, origin: 'synthetic-source-codec', rootBlobId: hex(metadata.latestRootBlobId),
    blobs: Object.fromEntries([...blobs].map(([id, bytes]) => [id, hex(bytes)])) });
  const observations = { normalRestore: true, restoredTurns: restored.conversationState.turns.length,
    projectedRequestId: restoredTurn.requestId ?? null, requestIdThroughDedicatedGetter: 'synthetic-request' };
  if (attachment) {
    assert.equal(restored.conversationState.summary.summary, 'Synthetic summary');
    assert.equal(hex(restoredTurn.userMessage.selectedContext.selectedImages[0].dataOrBlobId.value), hex(attachment));
    assert.equal(restoredTurn.steps[0].message.value.tool.value.result.result.value.output.value, 'fixture');
    blobs.delete(hex(attachment));
    const withoutAttachment = await reader.getFullConversation(ctx);
    observations.attachmentReferenceRetainedWithoutPayload = withoutAttachment.turns[0].turn.value.userMessage.selectedContext.selectedImages.length === 1;
    assert.equal(observations.attachmentReferenceRetainedWithoutPayload, true);
  }
  if (childId) {
    assert.equal(Object.keys(restored.subagentStates).length, 1);
    assert.deepEqual(reader.getLatestCheckpoint().pendingToolCalls, ['synthetic-unfinished-tool']);
    observations.pendingCallsRetainedInCheckpoint = true;
    observations.subagentsRestored = 1;
    blobs.delete(hex(childId));
    await assert.rejects(() => resolveSubagentPersistedStates(ctx, reader.getLatestCheckpoint(), store), { name: 'BlobNotFoundError' });
    observations.missingChildRef = 'BlobNotFoundError';
  }
  blobs.delete(hex(stepId));
  observations.stepsAfterMissingStep = (await reader.getFullConversation(ctx)).turns[0].turn.value.steps.length;
  assert.equal(observations.stepsAfterMissingStep, 0);
  blobs.delete(hex(userId));
  observations.turnsAfterMissingUser = (await reader.getFullConversation(ctx)).turns.length;
  assert.equal(observations.turnsAfterMissingUser, 0);
  results.push({ kind, observations, trace });
}

const asarPath = 'dist/Grok Bot 0.18 Reconstructed-win32-x64/resources/app.asar';
const asarJson = name => JSON.parse(Buffer.from(extractFile(asarPath, name)).toString('utf8'));
const packagedBuild = asarJson('dist/reconstruction-build.json');
const native = asarJson('dist/deps/runtime-deps-manifest.json');
const audit = asarJson('dist/runtime-composition-audit.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = {
  asarSha256: sha256(await readFile(asarPath)),
  packagedBuildSha256: sha256(Buffer.from(extractFile(asarPath, 'dist/reconstruction-build.json'))),
  localBuildSha256: sha256(await readFile('.build/clean-runtime/dist/reconstruction-build.json')),
  composition: packagedBuild.runtimeComposition.map(({ runtime, mode, source, path }) => ({ runtime, mode, source, path })),
  nativeModules: native.nodeFiles, auditSummary: audit.summary,
};
const sourceFiles = [
  'source/packages/agent-kv/agent-store.ts', 'source/packages/agent-kv/serde.ts',
  'source/packages/agent-kv/subagent-states.ts', 'source/packages/agent-kv/blob-store.ts',
  'source/packages/proto/generated/agent/v1/agent_pb.ts',
  'source/packages/proto/generated/agent/v1/selected_context_pb.ts',
  'source/packages/proto/generated/agent/v1/read_tool_pb.ts',
];
const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha256(await readFile(name))])));
const result = { schemaVersion: 1, node: process.version, sourceSha256, scope: 'source-codec-memory-only; no legacy engine execution, encryption, SQLite or UI import tested', artifact, results };
await writeFile(path.join(out, 'synthetic-fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n');
await writeFile(path.join(out, 'probe-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ node: result.node, artifact, results: results.map(({ kind, observations }) => ({ kind, observations })) }, null, 2));

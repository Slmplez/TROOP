// Throwaway experiment. Run from repository root with the bundled Node 26.5.0.
// Reads only repository fixtures/source; creates fresh PROTOTYPE SQLite files.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { proto3 } from '@bufbuild/protobuf';

const output = '.scratch/troop-history-import';
const scratch = path.resolve('.tmp-history-import');
await mkdir(scratch, { recursive: true });
const temp = await mkdtemp(path.join(scratch, 'PROTOTYPE-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
await build({ stdin: { contents: `export * from './source/packages/proto/generated/agent/v1/agent_pb.ts'; export { SCHEMA as STORE_SCHEMA } from './source/host/extensions/session/agent-db-schema.ts';`, resolveDir: process.cwd(), loader: 'ts' }, outfile: path.join(scratch, 'codec.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'warning' });
const P = await import(pathToFileURL(path.join(scratch, 'codec.mjs')).href);
const fixtures = JSON.parse(await readFile('docs/research/troop-runtime-baseline-2026-11-01/synthetic-fixtures.json', 'utf8'));
const schemaSource = await readFile('source/host/agent-isolation/conversation-blob-db.ts', 'utf8');
const sql = schemaSource.match(/CONVERSATION_BLOB_SCHEMA = `([\s\S]*?)`;/)[1];
const findings = [];
const records = [];
for (const fixture of fixtures) {
  const dbPath = path.join(temp, fixture.kind + '.PROTOTYPE.db');
  const writable = new DatabaseSync(dbPath);
  writable.exec(sql);
  const insert = writable.prepare('INSERT INTO blobs (id,data) VALUES (?,?)');
  for (const [id, data] of Object.entries(fixture.blobs)) insert.run(id, bytes(data));
  writable.close();
  const before = sha(await readFile(dbPath));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT id,data FROM blobs ORDER BY id').all();
  const graph = Object.fromEntries(rows.map(row => [row.id, Buffer.from(row.data).toString('hex')]));
  db.close();
  const metadata = { legacyId: fixture.kind, root: { addressing: 'content-hash', id: fixture.rootBlobId }, sourceNamespace: 'synthetic-baseline-018', provenance: 'synthetic; not a legacy metadata file' };
  const jsonPath = path.join(temp, fixture.kind + '.PROTOTYPE.json');
  await writeFile(jsonPath, JSON.stringify(metadata));
  const manifest = JSON.parse(await readFile(jsonPath, 'utf8'));
  const root = P.ConversationStateStructure.fromBinary(bytes(graph[manifest.root.id]));
  const turns = root.turns.map(id => P.ConversationTurnStructure.fromBinary(bytes(graph[Buffer.from(id).toString('hex')])));
  const content = [];
  const attachmentRefs = [];
  for (const turn of turns) {
    const t = turn.turn.value;
    const user = P.UserMessage.fromBinary(bytes(graph[Buffer.from(t.userMessage).toString('hex')]));
    content.push({ kind: 'user', text: user.text, sourceBlob: Buffer.from(t.userMessage).toString('hex') });
    for (const selected of user.selectedContext?.selectedImages ?? []) {
      attachmentRefs.push({ name: selected.path, blob: Buffer.from(selected.dataOrBlobId.value).toString('hex'), mime: selected.mimeType });
    }
    for (const id of t.steps) {
      const step = P.ConversationStep.fromBinary(bytes(graph[Buffer.from(id).toString('hex')]));
      content.push({ kind: step.message.case, text: step.message.case === 'assistantMessage' ? step.message.value.text : '人工 Read 工具记录：fixture.txt → fixture', sourceBlob: Buffer.from(id).toString('hex') });
    }
  }
  const childRefs = Object.entries(root.subagentStateRefs).map(([legacyId, id]) => ({ legacyId, blob: Buffer.from(id).toString('hex') }));
  const summary = root.summary ? P.ConversationSummary.fromBinary(bytes(graph[Buffer.from(root.summary).toString('hex')])).summary : null;
  const integrity = rows.every(row => sha(row.data) === row.id);
  const unchanged = before === sha(await readFile(dbPath));
  if (!integrity || !unchanged) throw new Error('Synthetic snapshot integrity changed');
  records.push({ schemaVersion: 'troop-history-prototype/0', source: manifest, revision: sha(Buffer.from(JSON.stringify(graph))), execution: 'historical-only', content, attachmentRefs, summary, childRefs, pendingToolCalls: root.pendingToolCalls, originals: fixture.blobs });
  findings.push({ kind: fixture.kind, sqliteBlobs: rows.length, contentHashChecks: integrity, sourceUnchanged: unchanged, turns: turns.length, contentItems: content.length, attachmentRefs: attachmentRefs.length, childRefs: childRefs.length, pendingCalls: root.pendingToolCalls.length });
}

// Exercise the inspected artifact class alone; no host entrypoint is evaluated.
const artifactPath = 'src/app/dist/host/host-main.cjs';
const artifact = await readFile(artifactPath, 'utf8');
const start = artifact.indexOf('var EncryptedBlobStore = class _EncryptedBlobStore');
const endMarker = 'EncryptedBlobStore.IV_LENGTH = 12;';
const end = artifact.indexOf(endMarker, start) + endMarker.length;
if (start < 0 || end <= start) throw new Error('Expected artifact encryption region absent');
const region = artifact.slice(start, end);
const metric = { histogram() {}, increment() {} };
const EncryptedBlobStore = runInNewContext(region + '\nEncryptedBlobStore;', {
  crypto: webcrypto, TextEncoder, Uint8Array, performance,
  encryptedGetBlobLatency: metric, encryptedSetBlobLatency: metric, cachedNearbyDecryptFallbackSuccess: metric,
  toUint8Array2: data => data,
  NearbyBlobDecryptError: class extends Error { constructor(cause) { super('Decryption failed', { cause }); this.name = 'NearbyBlobDecryptError'; } },
  __awaiter60: (receiver, args, _Promise, fn) => new Promise((resolve, reject) => {
    const g = fn.apply(receiver, args ?? []);
    const advance = (method, value) => { let result; try { result = g[method](value); } catch (error) { reject(error); return; } if (result.done) resolve(result.value); else Promise.resolve(result.value).then(v => advance('next', v), e => advance('throw', e)); };
    advance('next');
  }),
});
const plaintext = bytes(Object.values(fixtures[0].blobs)[0]);
const syntheticKey = '01'.repeat(32); // Artificial fixture key, never user data.
const ciphertext = await new EncryptedBlobStore({}, syntheticKey).encryptBlob(plaintext);
const backend = { async getBlob() { return ciphertext; } };
const correct = await new EncryptedBlobStore(backend, syntheticKey).getBlob({}, new Uint8Array());
let wrongKeyRejected = false;
try { await new EncryptedBlobStore(backend, '02'.repeat(32)).getBlob({}, new Uint8Array()); } catch (e) { wrongKeyRejected = e.name === 'NearbyBlobDecryptError'; }
const changed = ciphertext.slice(); changed[changed.length - 1] ^= 1;
let alteredTagRejected = false;
try { await new EncryptedBlobStore({ async getBlob() { return changed; } }, syntheticKey).getBlob({}, new Uint8Array()); } catch (e) { alteredTagRejected = e.name === 'NearbyBlobDecryptError'; }
const fallback = await new EncryptedBlobStore(backend, '02'.repeat(32), syntheticKey).getBlob({}, new Uint8Array());
if (sha(correct) !== sha(plaintext) || !wrongKeyRejected || !alteredTagRejected || sha(fallback) !== sha(plaintext)) throw new Error('Artifact vector observation unexpected');
const encryptedObservation = { evidence: 'inspected artifact class + synthetic input; not real historical ciphertext', artifactPath, regionSha256: sha(region), algorithm: 'AES-GCM', derivation: 'SHA-256(UTF-8 key string)', ivPrefixBytes: 12, additionalAuthenticatedData: false, correctKeyRoundtrip: true, wrongKeyRejected, alteredTagRejected, decryptFallbackWorks: true, missingKeyPolicy: 'do not generate or guess a replacement key', ciphertextBytes: ciphertext.length };

const message = new P.UserMessage({ text: 'Unknown-field synthetic example', messageId: 'unknown-field' });
const withUnknown = Uint8Array.from([...message.toBinary(), 0xa0, 0x06, 0x01]); // Field 100, varint=1.
const parsed = P.UserMessage.fromBinary(withUnknown);
const unknownCount = proto3.bin.listUnknownFields(parsed).length;
const retained = Buffer.from(parsed.toBinary()).equals(Buffer.from(withUnknown));
const jsonLosesUnknown = proto3.bin.listUnknownFields(P.UserMessage.fromJson(parsed.toJson())).length === 0;
if (unknownCount !== 1 || !retained || !jsonLosesUnknown) throw new Error('Unknown-field observation unexpected');

// The same logical key can be a fixed root slot, not a content hash.
const fixedSlot = 'sand-live-conversation-root-v1__';
const root = bytes(fixtures[0].blobs[fixtures[0].rootBlobId]);
const fixedRootObservation = { rootAddressing: 'fixed-slot', sourceSlot: fixedSlot, slotHex: Buffer.from(fixedSlot).toString('hex'), payloadSha256: sha(root), decodable: P.ConversationStateStructure.fromBinary(root).turns.length === 1, note: 'Artificial fixed-slot vector; real legacy root lookup is not tested.' };

const legacyPath = path.join(temp, 'store.PROTOTYPE.db');
const legacy = new DatabaseSync(legacyPath);
legacy.exec(P.STORE_SCHEMA);
const rawMetadata = { agentId: 'synthetic-fixed-root', name: 'Synthetic', latestRootBlobId: fixedRootObservation.slotHex, mode: 'default', isRunEverything: false, createdAt: 0 };
legacy.prepare('INSERT INTO kv (key,value) VALUES (?,?)').run('metadata', Buffer.from(JSON.stringify(rawMetadata), 'utf8').toString('hex'));
legacy.prepare('INSERT INTO blobs (id,data) VALUES (?,?)').run(fixedRootObservation.slotHex, root);
legacy.close();
const legacyBefore = sha(await readFile(legacyPath));
const legacyReader = new DatabaseSync(legacyPath, { readOnly: true });
const decodedMetadata = JSON.parse(Buffer.from(legacyReader.prepare('SELECT value FROM kv WHERE key=?').get('metadata').value, 'hex').toString('utf8'));
const fixedRootBytes = legacyReader.prepare('SELECT data FROM blobs WHERE id=?').get(decodedMetadata.latestRootBlobId).data;
const rootDecoded = P.ConversationStateStructure.fromBinary(fixedRootBytes);
legacyReader.close();
const storeDbObservation = { schema: 'actual source SCHEMA, synthetic rows', metadataEncoding: 'kv.metadata = hex(UTF-8 JSON)', rawKeyPresent: Object.hasOwn(decodedMetadata, 'blobEncryptionKey'), generatedReplacementKey: false, fixedSlotRootResolved: rootDecoded.turns.length === 1, sourceUnchanged: legacyBefore === sha(await readFile(legacyPath)) };
if (!storeDbObservation.sourceUnchanged || !storeDbObservation.fixedSlotRootResolved) throw new Error('Metadata/root experiment failed');

const evidence = { origin: 'synthetic-only', node: process.version, sqliteSchemaSha256: sha(sql), findings, encryptedObservation, unknownFieldObservation: { unknownCount, binaryRetained: retained, jsonLosesUnknown }, fixedRootObservation, storeDbObservation, notVerified: ['real legacy SQLite exports and WAL consistency', 'real encrypted history/key provenance', 'complete reference graph for arbitrary legacy types', 'cross-source identity equivalence', 'production transactions, crash recovery and UI import'] };
await writeFile(output + '/observations.json', JSON.stringify(evidence, null, 2) + '\n');
await writeFile(output + '/intermediate-example.json', JSON.stringify(records, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));

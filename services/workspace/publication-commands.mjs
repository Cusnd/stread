import { randomUUID } from 'node:crypto';
import { canonical, check, errorBody, hash, identifier, json, object, version } from './errors.mjs';
import { authoringArtifactManifest, prepareAuthoring, authoringSubmission } from './authoring-core.mjs';
import { freezeAuthoringPreview, preparePreviewPublication, previewDescriptor, previewPublication, previewSubmission } from './authoring-preview.mjs';
import { revisionReferenceGuard } from './authoring-edit-package.mjs';
import { OBJECT_MARKER } from './immutable-objects.mjs';
import { createReadSet } from './sql-commit.mjs';
import { commitAuxiliary, commitBusiness, findBusinessReceipt } from './business-commit.mjs';
import { prepareRelationChanges } from './relations.mjs';
import { queuePreviewBinding, queuePreviewChange, completeConversion, checkQueueDelivery } from './queue-data.mjs';

const now = () => new Date().toISOString();

// Only trusted in-process callers provide this execution context. It is not a
// field in authoring JSON, HTTP input, or the public MCP publication schema.
function publicationRequestBinding(execution) {
  if (execution === undefined) return undefined;
  object(execution, 'Publication execution context');
  check(Object.keys(execution).every(key => key === 'changeRequest'), 'VALIDATION_FAILED', 'Unknown publication execution context.');
  if (execution.changeRequest === undefined) return undefined;
  const value = object(execution.changeRequest, 'Publication request binding');
  check(Object.keys(value).every(key => ['documentId', 'changeRequestId', 'expectedVersion', 'revision'].includes(key)), 'VALIDATION_FAILED', 'Unknown publication request binding field.');
  return { documentId: identifier(value.documentId), changeRequestId: identifier(value.changeRequestId),
    expectedVersion: version(value.expectedVersion), revision: version(value.revision) };
}

async function boundPublicationRequest(workspace, reads, prepared, binding) {
  if (!binding) return null;
  check(prepared.revisionTarget?.documentId === binding.documentId && prepared.revisionTarget.baseRevision === binding.revision,
    'CHANGE_REQUEST_TARGET_MISMATCH', 'The revision preview differs from the saved request document or source revision.', 409);
  const row = await reads.get('SELECT * FROM change_requests WHERE id=? AND document_id=?', binding.changeRequestId, binding.documentId);
  check(row, 'NOT_FOUND', 'The saved change request no longer exists.', 404);
  workspace.expected(row, binding.expectedVersion);
  const request = JSON.parse(row.payload);
  check(request.status === 'pending' && request.revision === binding.revision, 'REVISION_CONFLICT', 'The saved request was changed, withdrawn or already applied.', 409);
  return request;
}

async function draftHead(reads, snapshot) {
  const draftRow = await reads.get('SELECT payload FROM authoring_drafts WHERE id=?', snapshot.draftId);
  check(draftRow, 'NOT_FOUND', '草稿不存在。', 404); const draft = JSON.parse(draftRow.payload);
  check(draft.currentPreviewId === snapshot.id, 'PREVIEW_SUPERSEDED', '已有更新的草稿，请读取当前草稿后重试。', 409, { draftId:draft.id,currentPreviewId:draft.currentPreviewId });
  const preview = await reads.get('SELECT * FROM authoring_previews WHERE id=?', snapshot.id);
  check(preview, 'NOT_FOUND', '草稿快照不存在。', 404);
  check(!preview.published_document_id, 'PREVIEW_ALREADY_PUBLISHED', '这份草稿已发布；新文档请创建新的草稿。', 409);
  return draft;
}

export async function checkPublicationTarget(reads, prepared) {
  const target=prepared.revisionTarget;if(!target)return;
  const current=await reads.get('SELECT * FROM documents WHERE id=?',target.documentId);
  check(current,'NOT_FOUND','没有找到这份文档。',404);
  check(current.current_revision===target.baseRevision,'REVISION_CONFLICT','正式正文已改变，请重新生成并核对修订候选。',409,{documentId:target.documentId,expectedRevision:target.baseRevision,currentRevision:current.current_revision});
  const baseline=await reads.get('SELECT * FROM revisions WHERE document_id=? AND revision=?',target.documentId,target.baseRevision);
  check(hash(canonical(baseline))===target.baseRecordHash,'REVISION_BASE_MISMATCH','修订基准记录已改变，请重新取得当前编辑包。',409,{documentId:target.documentId,baseRevision:target.baseRevision});
  const guard=await revisionReferenceGuard(reads,target.documentId,target.impact,prepared.validated.index);
  check(guard.hash===target.referenceGuardHash,'REVISION_REFERENCES_CHANGED','受修订影响的引用已改变，请重新生成候选并核对引用影响。',409,{documentId:target.documentId,baseRevision:target.baseRevision});
}

function previewMetadata(snapshot,payload){return {entity:'preview_metadata',value:{preview_id:snapshot.id,draft_id:snapshot.draftId,preview_hash:snapshot.hash,payload_hash:hash(payload)}};}

export async function createPreview(workspace, actor, input) {
  workspace.authorize(actor,'write');
  const submission=previewSubmission(input),command={kind:'authoring.preview',...submission};
  const existing=await findBusinessReceipt(workspace,command);if(existing.receipt)return existing.receipt;
  const previous=submission.previousPreviewId?await workspace.previewSnapshot(submission.previousPreviewId):null;
  if(previous)await draftHead(createReadSet(workspace.sql),previous);
  const previousTarget=previous?.revisionTarget&&Object.fromEntries(['documentId','baseRevision','baseHash'].map(key=>[key,previous.revisionTarget[key]]));
  check(!previous||canonical(submission.target||previousTarget||null)===canonical(previousTarget||null),'REVISION_TARGET_MISMATCH','同一草稿不能更换修订目标或基准版本。',409,previous?{draftId:previous.draftId,currentPreviewId:previous.id,...(previousTarget?{documentId:previousTarget.documentId}:{})}:undefined);
  const target=submission.target||previousTarget;let prepared;
  try{
    prepared=await prepareAuthoring(workspace,{authoringSourceId:submission.authoringSourceId,resources:submission.resources,...(target?{target}:{})},previous?{identity:previous.compiled.identity,document:previous.validated.document}:null);
  }catch(error){
    if(previous){
      const reads=createReadSet(workspace.sql),row=await reads.get('SELECT payload FROM authoring_drafts WHERE id=?',previous.draftId),preview=await reads.get('SELECT published_document_id FROM authoring_previews WHERE id=?',previous.id);
      const draft=row&&JSON.parse(row.payload);
      if(draft?.currentPreviewId===previous.id&&!preview?.published_document_id){
        draft.lastError=errorBody(error);draft.version++;draft.updatedAt=now();
        const changes=[{entity:'authoring_drafts',value:{id:draft.id,payload:json(draft)}}],statements=[];
        const queued=await reads.get("SELECT q.id FROM queue_task_previews p JOIN queue_tasks q ON q.id=p.task_id AND q.version=p.task_version WHERE p.preview_id=? AND json_extract(q.payload,'$.status')='pending'",previous.id);
        if(queued){
          const revision=JSON.parse((await reads.get("SELECT value FROM metadata WHERE key='revision'")).value)+1;
          changes.push({entity:'metadata',value:{key:'revision',value:json(revision)}});
          statements.push({sql:'INSERT INTO changes VALUES(?,?,?)',values:[revision,json({kind:'queue.preview_diagnostic',taskId:queued.id}),now()]});
        }
        await commitAuxiliary(workspace,{reads,changes,statements,requestId:'preview-diagnostic-'+randomUUID()});
      }
    }
    throw error;
  }
  const candidate=freezeAuthoringPreview(prepared,previous?.id);candidate.draftId=previous?.draftId||'draft-'+candidate.hash;
  const found=(await workspace.sql.query('SELECT payload FROM authoring_previews WHERE id=?',[candidate.id]))[0];
  const snapshot=found?await workspace.previewSnapshot(candidate.id):candidate;
  const reference=await workspace.storage.stage(snapshot);await workspace.storage.stage(snapshot.validation);
  return commitBusiness(workspace,actor,command,async reads=>{
    const currentDraft=previous?await draftHead(reads,previous):null;
    await checkPublicationTarget(reads,prepared);
    const queueTask=await queuePreviewBinding(workspace,reads,snapshot);
    const existing=await reads.get('SELECT * FROM authoring_previews WHERE id=?',snapshot.id),payload=json({[OBJECT_MARKER]:reference});
    const draft={id:snapshot.draftId,version:(currentDraft?.version||0)+1,currentPreviewId:snapshot.id,lastError:null,updatedAt:now()};
    return {workspaceChange:false,changes:[...(existing?[]:[{entity:'authoring_previews',value:{id:snapshot.id,payload,published_document_id:null}}]),
      previewMetadata(snapshot,payload),{entity:'authoring_drafts',value:{id:draft.id,payload:json(draft)}},...(queueTask?[queuePreviewChange(queueTask,snapshot)]:[])],result:{preview:previewDescriptor(snapshot),validation:snapshot.validation}};
  });
}

async function preparePublication(workspace,actor,prepared,reads){
  const {compiled,validated,resourceMap,validation}=prepared,document=validated.document,target=prepared.revisionTarget;
  let row;
  if(target){
    await checkPublicationTarget(reads,prepared);
    check(document.id===target.documentId&&document.revision===target.baseRevision+1,'PREVIEW_HASH_MISMATCH','候选正文与冻结的修订目标不一致。',409);
    const previous=await reads.get('SELECT * FROM documents WHERE id=?',document.id),metadata=JSON.parse(previous.metadata);
    if(document.meta.title!==target.baseTitle)metadata.title=document.meta.title;
    row={...previous,current_revision:document.revision,version:previous.version+1,metadata:json(metadata),updated_at:now()};
  }else{
    check(!await reads.get('SELECT id FROM documents WHERE id=?',document.id),'DOCUMENT_ID_CONFLICT','作者输入生成的文档 ID 已存在。',409);
    const metadata={title:document.meta.title,kind:document.source?.media_type==='application/pdf'||document.source?.path.toLowerCase().endsWith('.pdf')?'PDF':'文档',
      summary:document.blocks.find(block=>block.type==='para')?.text?.slice(0,800)||'',collectionIds:[],tags:[],status:'unread',
      diagnostics:[...validated.report.diagnostics,...compiled.report.warnings.map(warning=>({code:warning.code,message:warning.detail||warning.code}))]};
    row={id:document.id,version:1,current_revision:document.revision,metadata:json(metadata),archived_at:null,created_at:now(),updated_at:now()};
  }
  const revision=workspace.storage.preparedChanges(validated,resourceMap,{authoring:compiled.authoring,identity:compiled.identity,actor:actor.subjectId||'local'});
  return {changes:[{entity:'documents',value:row},...revision.changes],statements:revision.statements,
    result:{document:{id:document.id,revision:document.revision},readerUrl:`/?document=${encodeURIComponent(document.id)}`,validation:{...validation,published:true},
      artifacts:authoringArtifactManifest({...validated,authoring:compiled.authoring,identity:compiled.identity}),
      ...(target?{revisionTarget:{documentId:target.documentId,baseRevision:target.baseRevision,baseHash:target.baseHash},impact:validation.revisionTarget}:{})}};
}

export async function publishPreview(workspace,actor,input,execution){
  workspace.authorize(actor,'write');const submission=previewPublication(input),binding=publicationRequestBinding(execution);
  const command={kind:'authoring.preview.publish',...submission,...(binding?{changeRequestBinding:binding}:{})};
  const existing=await findBusinessReceipt(workspace,command);if(existing.receipt)return existing.receipt;
  const snapshot=await workspace.previewSnapshot(submission.previewId),draft=await draftHead(createReadSet(workspace.sql),snapshot);
  check(!draft.lastError,'PREVIEW_INVALID_UPDATE','最新修改未通过校验，请修复后重新预览。',409);
  const prepared=await preparePreviewPublication(workspace,snapshot,submission);
  await workspace.prepareRevision(prepared.validated,prepared.resourceMap,prepared.compiled);
  return commitBusiness(workspace,actor,command,async reads=>{
    const head=await draftHead(reads,snapshot);check(!head.lastError,'PREVIEW_INVALID_UPDATE','最新修改未通过校验，请修复后重新预览。',409);
    const request=await boundPublicationRequest(workspace,reads,prepared,binding);
    const queueTask=await queuePreviewBinding(workspace,reads,snapshot);
    const result=await preparePublication(workspace,actor,prepared,reads);
    checkQueueDelivery(queueTask,prepared);
    if(queueTask) result.changes.push(completeConversion(queueTask,result.result.document));
    if(request){
      const completed={...request,status:'completed',version:request.version+1,appliedRevision:result.result.document.revision,updatedAt:now()};
      result.changes.push({entity:'change_requests',value:{id:completed.id,document_id:completed.documentId,version:completed.version,reference:completed.reference,payload:json(completed)}});
      result.result.changeRequest=completed;
    }
    const stored=await reads.get('SELECT * FROM authoring_previews WHERE id=?',snapshot.id);
    result.changes.push({entity:'authoring_previews',value:{...stored,published_document_id:result.result.document.id}});
    result.result.preview=previewDescriptor(snapshot,result.result.document.id,prepared.validated.report.previewSubmission?.quality);
    const relations=await prepareRelationChanges({reads,documents:[prepared.validated.document],documentRows:[result.changes[0].value]});
    result.changes.push(...relations.changes);result.statements.push(...relations.statements);
    return result;
  });
}

export async function publishAuthoringInput(workspace,actor,input){
  workspace.authorize(actor,'write');const submission=authoringSubmission(input,true),command={kind:'authoring.publish',...submission};
  check(!submission.target,'PREVIEW_REQUIRED','已有文章的完整修订必须创建并审阅冻结预览后发布。',409);
  const existing=await findBusinessReceipt(workspace,command);if(existing.receipt)return existing.receipt;
  const prepared=await prepareAuthoring(workspace,{authoringSourceId:submission.authoringSourceId,resources:submission.resources});
  check(prepared.compiled.authoring.extensions?.['stread.queue']===undefined,'PREVIEW_REQUIRED','队列转换必须创建并复审冻结预览后发布。',409);
  await workspace.prepareRevision(prepared.validated,prepared.resourceMap,prepared.compiled);
  return commitBusiness(workspace,actor,command,async reads=>{
    const result=await preparePublication(workspace,actor,prepared,reads);
    const relations=await prepareRelationChanges({reads,documents:[prepared.validated.document],documentRows:[result.changes[0].value]});
    result.changes.push(...relations.changes);result.statements.push(...relations.statements);
    return result;
  });
}

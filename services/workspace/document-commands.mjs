import { randomUUID } from 'node:crypto';
import { canonical, check, clone, fail, hash, identifier, json, object, text, version } from './errors.mjs';
import { applyOperations } from './documents.mjs';
import { prepareRelationChanges } from './relations.mjs';

const now = () => new Date().toISOString();
const parsed = row => row ? JSON.parse(row.payload) : undefined;
const referencePattern = /^#([QN])([0-9]{5,})$/;
const noteSignature = note => canonical(Object.fromEntries(['id','title','body','type','color','quote','blockId','variant','field','answer'].filter(key => note[key] !== undefined).map(key => [key,note[key]])));

export async function prepareDocumentCommand(context) {
  const { workspace, actor, command, reads, rows, getDocument, getMeta, revision, material, allocate, saveInsight, storeInsight, storeRequest } = context;
  const kind = command.kind;
  const proposalRow = async id => {
    const row = await reads.get('SELECT payload FROM proposals WHERE id=?', identifier(id)); check(row, 'NOT_FOUND', '修订提案不存在。',404);
    return workspace.storage.unpack(parsed(row));
  };
  const storeProposal = value => rows.put('proposals', { id:value.id, document_id:value.documentId, status:value.status, payload:workspace.storage.pack(value) });
  const pendingRequest = async (id, documentId, expectedVersion) => {
    if (!id) return null;
    const row = await reads.get('SELECT * FROM change_requests WHERE id=? AND document_id=?',identifier(id),identifier(documentId));
    check(row,'NOT_FOUND','更改请求不存在。',404); workspace.expected(row,expectedVersion); const value=parsed(row);
    check(value.status==='pending','REVISION_CONFLICT','此请求已撤回或处理，请重新读取。',409); return value;
  };
  const complete = (request, extra) => {
    if (!request) return undefined;
    const value={...request,status:'completed',...extra,version:request.version+1,updatedAt:now()}; storeRequest(value); return value;
  };
  const revisionChanges = async (validated,saved) => {
    await workspace.prepareRevision(validated,saved.resourceMap,saved);
    const prepared=workspace.storage.preparedChanges(validated,saved.resourceMap,{actor:actor.subjectId,...saved});
    for(const change of prepared.changes)rows.put(change.entity,change.value); rows.statements.push(...prepared.statements);
    const row=await getDocument(validated.document.id),metadata=JSON.parse(row.metadata);
    if(validated.document.meta.title!==saved.document.meta.title)metadata.title=validated.document.meta.title;
    return rows.put('documents',{...row,current_revision:validated.document.revision,version:row.version+1,metadata:json(metadata),updated_at:now()});
  };

  if(kind==='object_preferences.update'){
    const document=await getDocument(command.documentId),saved=await revision(document.id,command.documentRevision);
    const objects=object(command.objects,'对象设置'),entries=Object.entries(objects);
    check(entries.length>0&&entries.length<=1000,'VALIDATION_FAILED','一次最多保存 1000 个对象设置。');
    check(command.onlyIfAbsent===undefined||typeof command.onlyIfAbsent==='boolean','VALIDATION_FAILED','迁移方式无效。');
    const existing=await reads.all('SELECT block_id,payload FROM object_preferences WHERE document_id=?',document.id);
    const nextObjects=Object.fromEntries(existing.map(row=>[row.block_id,parsed(row)]));
    for(const [blockId,patch]of entries){
      identifier(blockId,'对象标识');object(patch,'对象设置'); const fields=Object.entries(patch);check(fields.length>0,'VALIDATION_FAILED','对象设置不能为空。');
      for(const [field,value]of fields){const bounds={widthPercent:[1,400],fontSize:[12,32]}[field];check(Array.isArray(bounds)&&(value===null||Number.isFinite(value)&&value>=bounds[0]&&value<=bounds[1]),'VALIDATION_FAILED','对象尺寸或字号无效。',400,{blockId,field});}
      const block=saved.document.blocks.find(item=>item.id===blockId&&['figure','table','html'].includes(item.type));
      if(!block&&command.onlyIfAbsent)continue;check(block,'ANCHOR_UNRESOLVED','指定图表或图片不存在。',409,{blockId});
      const previous=nextObjects[blockId];if(command.onlyIfAbsent&&previous)continue;
      const value={widthPercent:null,fontSize:null,...previous,...Object.fromEntries(fields.map(([field,value])=>[field,value===null?null:Math.round(value*10)/10]))};
      nextObjects[blockId]=value;rows.put('object_preferences',{document_id:document.id,block_id:blockId,payload:json(value)});
    }
    return rows.finish({documentId:document.id,workspaceRevision:await getMeta('revision'),documentRevision:document.current_revision,objects:nextObjects});
  }
  if(kind==='document.revise'){
    const row=await getDocument(command.documentId),saved=await revision(row.id);
    version(command.expectedRevision,'预期正文版本');check(saved.document.revision===command.expectedRevision,'REVISION_CONFLICT','正文版本已经改变。',409,{currentRevision:saved.document.revision});
    check(!saved.readOnly,'READ_ONLY','此文档当前仅支持只读。',409);
    const operations=clone(command.operations),proposed=await applyOperations(saved.document,operations),validated=await workspace.validateCandidate(proposed.document,saved);
    await workspace.prepareRevision(validated,saved.resourceMap,saved); await workspace.storage.stage(operations);await workspace.storage.stage(proposed.changes);
    const request=await pendingRequest(command.changeRequestId,row.id,command.expectedChangeRequestVersion);
    let result,documents=[],documentRows=[];
    if(command.authorized!==true){
      const proposal={id:'proposal-'+randomUUID(),documentId:row.id,expectedRevision:command.expectedRevision,...(request?{changeRequestId:request.id,expectedChangeRequestVersion:request.version}:{}),
        operations,before:saved.document,after:validated.document,changes:proposed.changes,status:'pending',createdAt:now(),payloadHash:hash(canonical(validated.document)),createdBy:actor.subjectId};
      storeProposal(proposal);result={proposal};
    }else{
      const updated=await revisionChanges(validated,saved);
      result={document:validated.document,record:await material(updated),changes:proposed.changes,...(request?{changeRequest:complete(request,{appliedRevision:validated.document.revision})}:{})};
      documents=[validated.document];documentRows=[updated];
    }
    const prepared=rows.finish(result),relations=await prepareRelationChanges({reads,documents,documentRows});
    prepared.changes.push(...relations.changes);prepared.statements.push(...relations.statements);
    return prepared;
  }
  if(kind==='proposal.reject'){
    const proposal=await proposalRow(command.proposalId);check(['pending','rejected'].includes(proposal.status),'REVISION_CONFLICT','此修订已经应用。',409);
    proposal.status='rejected';proposal.decidedAt||=now();storeProposal(proposal);return rows.finish({proposal});
  }
  if(kind.startsWith('relation.')||kind==='proposal.accept'){
    let proposal,operation=command;
    if(kind==='proposal.accept'){
      proposal=await proposalRow(command.proposalId);
      if(proposal.kind!=='relation'){
        if(proposal.status==='applied'){
          const saved=await revision(proposal.documentId,proposal.after.revision),result=rows.finish({proposal,document:saved.document,record:await material(await getDocument(proposal.documentId))});
          const relations=await prepareRelationChanges({reads});result.changes.push(...relations.changes);result.statements.push(...relations.statements);
          return result;
        }
        check(proposal.status==='pending','REVISION_CONFLICT','此提案已被拒绝。',409);
        check(hash(canonical(proposal.after))===proposal.payloadHash,'PROPOSAL_MISMATCH','提案内容已改变，不能沿用旧批准。',409);
        const saved=await revision(proposal.documentId);check(saved.document.revision===proposal.expectedRevision,'REVISION_CONFLICT','正文版本已改变，请重新生成修订。',409);
        const validated=await workspace.validateCandidate(proposal.after,saved);
        const request=await pendingRequest(proposal.changeRequestId,proposal.documentId,proposal.expectedChangeRequestVersion);
        const updated=await revisionChanges(validated,saved);
        for(const value of[proposal.before,proposal.after,proposal.operations,proposal.changes])if(value)await workspace.storage.stage(value);
        proposal.status='applied';proposal.decidedAt=now();proposal.appliedBy=actor.subjectId;storeProposal(proposal);
        const result=rows.finish({proposal,document:validated.document,record:await material(updated),...(request?{changeRequest:complete(request,{appliedRevision:validated.document.revision})}:{})});
        const relations=await prepareRelationChanges({reads,documents:[validated.document],documentRows:[updated]});
        result.changes.push(...relations.changes);result.statements.push(...relations.statements);
        return result;
      }
      if(proposal.status==='applied'){
        const row=await reads.get('SELECT payload FROM document_relations WHERE id=? AND document_id=?',proposal.after.id,proposal.documentId);check(row,'NOT_FOUND','文献关联不存在。',404);
        const result=rows.finish({proposal,relation:parsed(row)}),relations=await prepareRelationChanges({reads});
        result.changes.push(...relations.changes);result.statements.push(...relations.statements);
        return result;
      }
      check(proposal.status==='pending','REVISION_CONFLICT','此提案已被拒绝。',409);operation=proposal.operations[0];
      check(hash(canonical({operation,next:proposal.after}))===proposal.payloadHash,'PROPOSAL_MISMATCH','关联提案内容已改变。',409);
      operation={...operation,authorized:true,changeRequestId:proposal.changeRequestId,expectedChangeRequestVersion:proposal.expectedChangeRequestVersion};
    }
    const document=await getDocument(operation.documentId);check(!document.archived_at,'NOT_FOUND','资料已归档。',404);
    const prepared=await prepareRelationChanges({reads,command:operation,dryRun:operation.authorized!==true});
    const request=await pendingRequest(operation.changeRequestId,document.id,operation.expectedChangeRequestVersion);
    if(proposal)check(canonical(prepared.next)===canonical(proposal.after),'REVISION_CONFLICT','关联或目标文献已改变，请重新生成提案。',409);
    if(operation.authorized!==true){
      const op={kind:operation.kind,documentId:document.id,relationId:prepared.previous.id,expectedVersion:prepared.previous.version,...(operation.targetDocumentId?{targetDocumentId:operation.targetDocumentId}:{})};
      const candidate={id:'proposal-'+randomUUID(),kind:'relation',documentId:document.id,expectedRevision:document.current_revision,
        ...(request?{changeRequestId:request.id,expectedChangeRequestVersion:request.version}:{}),operations:[op],before:prepared.previous,after:prepared.next,
        changes:[{kind:operation.kind,blockId:prepared.previous.source.blockId,before:{status:prepared.previous.status,targetDocuments:prepared.previous.targetDocuments},after:{status:prepared.next.status,targetDocuments:prepared.next.targetDocuments}}],
        status:'pending',createdAt:now(),payloadHash:hash(canonical({operation:op,next:prepared.next})),createdBy:actor.subjectId};
      storeProposal(candidate);return rows.finish({proposal:candidate});
    }
    for(const change of prepared.changes)rows.put(change.entity,change.value,change.key?JSON.parse(change.key):undefined);rows.statements.push(...(prepared.statements||[]));
    if(proposal){proposal.status='applied';proposal.decidedAt=now();proposal.appliedBy=actor.subjectId;storeProposal(proposal);}
    const result=rows.finish({relation:prepared.relation,...(request?{changeRequest:complete(request,{appliedRelationId:prepared.relation.id,appliedRelationVersion:prepared.relation.version})}:{}),...(proposal?{proposal}:{})});
    if(proposal){
      const relations=await prepareRelationChanges({reads});result.changes.push(...relations.changes);result.statements.push(...relations.statements);
    }
    return result;
  }
  if(kind==='legacy.import'){
    const document=await getDocument(command.documentId);text(command.sessionKey,'旧会话标识',500,true);check(Array.isArray(command.notes)&&command.notes.length<=10000,'VALIDATION_FAILED','旧洞见列表无效。');
    for(const value of[command.notes,command.draft,command.rawSession])if(value&&typeof value==='object')await workspace.storage.stage(value);
    const digest=hash(canonical({notes:command.notes,draft:command.draft||null,rawSession:command.rawSession||null})),key='session:'+command.sessionKey+':'+digest;
    const prior=await reads.get('SELECT result FROM migrations WHERE key=?',key);if(prior)return rows.finish({migration:JSON.parse(prior.result)});
    const mappings=[],skippedExamples=[],preservedExisting=[];
    for(const raw of command.notes){
      identifier(raw.id,'旧洞见 ID');if(workspace.exampleSignatures.has(noteSignature(raw))){skippedExamples.push(raw.id);continue;}
      const prior=rows.pending('legacy_items',[command.sessionKey,raw.id])?.value||await reads.get('SELECT * FROM legacy_items WHERE session_key=? AND local_id=?',command.sessionKey,raw.id);
      if(prior){preservedExisting.push(raw.id);const insight=parsed(rows.pending('insights',[prior.insight_id])?.value||await reads.get('SELECT payload FROM insights WHERE id=?',prior.insight_id));mappings.push({oldId:raw.id,id:insight.id,oldReference:raw.reference,reference:insight.reference});continue;}
      const collision=rows.pending('insights',[raw.id])?.value||await reads.get('SELECT id FROM insights WHERE id=?',raw.id),id=collision?'insight-'+randomUUID():raw.id;
      const input={...raw,id,documentId:command.documentId,revision:raw.revision||document.current_revision,origin:raw.origin||'legacy'};
      const insight=await saveInsight({documentId:command.documentId,insight:input},{legacy:true,forcedId:id});
      for(const reference of new Set([raw.reference,...Object.values(raw.references||{})].filter(value=>referencePattern.test(value)))){
        rows.put('legacy_aliases',{document_id:document.id,reference,insight_id:insight.id});const series=referencePattern.exec(reference)[1];
        if(!insight.references[series]&&!rows.pending('references_map',[reference])&&!await reads.get('SELECT reference FROM references_map WHERE reference=?',reference)){
          insight.references[series]=await allocate(series,reference);rows.put('references_map',{reference:insight.references[series],insight_id:insight.id});storeInsight(insight);
        }
      }
      rows.put('legacy_items',{session_key:command.sessionKey,local_id:raw.id,insight_id:insight.id,signature:noteSignature(raw)});
      mappings.push({oldId:raw.id,id:insight.id,oldReference:raw.reference,reference:insight.reference});
    }
    const migration={imported:mappings.length-preservedExisting.length,mappings,skippedExamples,preservedExisting,retainedDraft:command.draft!==undefined,digest};
    rows.put('migrations',{key,digest,payload:workspace.storage.pack({documentId:command.documentId,sessionKey:command.sessionKey,notes:command.notes,draft:command.draft,rawSession:command.rawSession}),result:json(migration),created_at:now()});
    return rows.finish({migration});
  }
  fail('VALIDATION_FAILED','不支持的工作台操作。');
}

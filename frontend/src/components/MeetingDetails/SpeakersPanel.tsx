import type { useSpeakers } from '@/hooks/meeting-details/useSpeakers';
import { useEffect, useState } from 'react';
import { speakerCounts, speakerName, speakerRoot, SpeakerRun } from '@/lib/speakers';
import { formatTimestamp } from '@/lib/meeting-export/model';
const control='rounded border border-gray-300 bg-white px-2 py-1 text-sm disabled:opacity-50';
function NameEditor({run,id,disabled,save}:{run:SpeakerRun;id:string;disabled:boolean;save:(value:string)=>Promise<void>}) {
  const saved=run.overlay.names[id]||'';
  const [name,setName]=useState(saved);
  useEffect(()=>setName(saved),[saved]);
  return <div className="flex items-center gap-2">
    <label className="text-xs text-gray-500 min-w-[85px]" htmlFor={'speaker-name-'+id}>{id}</label>
    <input id={'speaker-name-'+id} aria-label={'Name for '+id} className={control+' min-w-0 flex-1'} placeholder={id} value={name} maxLength={120} disabled={disabled} onChange={e=>setName(e.target.value)}/>
    <button className={control} disabled={disabled || name===saved} onClick={()=>void save(name)}>Save name</button>
  </div>;
}
export function SpeakersPanel({controller,isRecording=false}:{controller:ReturnType<typeof useSpeakers>;isRecording?:boolean}) {
  const {view,error,pending,act}=controller;
  const [count,setCount]=useState('2');
  const [selected,setSelected]=useState('');
  const [source,setSource]=useState('');
  const [target,setTarget]=useState('');
  const [limit,setLimit]=useState(100);
  const runs=view?.snapshot.runs || [];
  const run=runs.find(r=>r.id===selected);
  useEffect(()=>{
    if(!runs.some(r=>r.id===selected))setSelected(view?.snapshot.active_id || runs[0]?.id || '');
  },[runs,selected,view?.snapshot.active_id]);
  useEffect(()=>{setSource('');setTarget('');setLimit(100);},[selected]);
  if(view && !view.supported)return null;
  const busy=view?.status.state==='running';
  const valid=Number.isInteger(Number(count)) && Number(count)>=1 && Number(count)<=12;
  const ids=run?[...new Set(run.turns.map(t=>speakerRoot(run,t.speaker)))]:[];
  const counts=run?speakerCounts(run):undefined;
  const activeRun=runs.find(r=>r.id===view?.snapshot.active_id);
  const mismatchRun=counts?.mismatch?run:activeRun && speakerCounts(activeRun).mismatch?activeRun:undefined;
  const mismatchCounts=mismatchRun?speakerCounts(mismatchRun):undefined;
  const edit=(action:string,speaker='',value='')=>act(action,{runId:selected,speaker,value});
  return <details className="border-b border-gray-200 bg-white text-gray-800">
    <summary className="cursor-pointer px-4 py-2 text-sm font-medium">Speakers <span className="font-normal text-gray-500">· experimental, after recording{busy?' · analyzing…':''}</span>{mismatchRun && <span className="text-amber-800"> · count mismatch — review required</span>}</summary>
    <div className="max-h-[360px] overflow-y-auto px-4 pb-4 space-y-3">
      <p className="text-xs text-gray-500">Anonymous voices; enter names yourself. Tested on two-person recordings, but long recordings can still miss voices. Mixed transcript chunks keep their original text and timing.</p>
      <p className="text-xs">{view?.readiness || 'Checking local runtime…'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="speaker-count">Requested participants</label>
        <input id="speaker-count" aria-label="Participant count" className={control+' w-16'} type="number" min={1} max={12} step={1} value={count} disabled={busy||pending} onChange={e=>setCount(e.target.value)}/>
        <button className={control} disabled={!view?.ready||!valid||busy||pending||isRecording} onClick={()=>act('start',{count:Number(count)})}>Analyze speakers</button>
        {busy && <button className={control} disabled={pending} onClick={()=>act('cancel')}>Cancel analysis</button>}
        <button className={control} disabled={pending} onClick={()=>controller.refresh()}>Refresh readiness</button>
      </div>
      {!valid && <p role="alert" className="text-sm text-red-700">Enter a whole participant count from 1 to 12.</p>}
      {isRecording && <p className="text-xs">Finish recording before analysis.</p>}
      {busy && <progress aria-label="Speaker analysis in progress" className="w-full"/>}
      {view?.status.message && <p role={view.status.state==='error'?'alert':'status'} className={'text-sm '+(view.status.state==='error'?'text-red-700':'')}>{view.status.message}{busy?' ('+view.status.elapsed_seconds+'s)':''}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!!runs.length && <>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm" htmlFor="speaker-result">Result ({runs.length} saved)</label>
          <select id="speaker-result" aria-label="Speaker result" className={control+' max-w-full'} value={selected} disabled={pending} onChange={e=>setSelected(e.target.value)}>
            {runs.map((r,i)=><option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString()} · requested {r.requested_speakers} · detected {speakerCounts(r).detected} · {r.id.slice(0,6)}{r.id===view?.snapshot.active_id?' · active':i===0?' · newest':''}</option>)}
          </select>
          <button className={control} disabled={pending||!run||selected===view?.snapshot.active_id} onClick={()=>edit('activate')}>Apply selected result</button>
          <button className={control} disabled={pending||!run||selected!==view?.snapshot.active_id} onClick={()=>edit('deactivate')}>Hide speaker labels</button>
        </div>
        {mismatchRun && mismatchCounts && <p aria-label="Speaker count mismatch" role="alert" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
          {mismatchRun.id===selected?'Selected':'Active'} result: requested {mismatchCounts.requested}, detected {mismatchCounts.detected}. The requested count is not guaranteed. Review this result manually before using its labels. You can hide active labels without deleting the result or your edits.
        </p>}
        {run && <>
          <p aria-label="Speaker counts" className="text-sm">Requested: {counts!.requested} · Detected voices: {counts!.detected} · Groups after merges: {counts!.groups}</p>
          <p className="text-xs text-gray-500">{selected===view?.snapshot.active_id?'Active in transcript and exports.':'Preview only. Apply explicitly to change transcript and export labels.'} Names belong to this result only.</p>
          <div className="space-y-2">{ids.map(id=><NameEditor key={run.id+id} run={run} id={id} disabled={pending} save={value=>edit('rename',id,value)}/>)}</div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Merge source" className={control} disabled={pending} value={source} onChange={e=>setSource(e.target.value)}><option value="">Merge voice…</option>{ids.map(id=><option key={id} value={id}>{speakerName(run,id)} ({id})</option>)}</select>
            <span className="text-xs">into</span>
            <select aria-label="Merge target" className={control} disabled={pending} value={target} onChange={e=>setTarget(e.target.value)}><option value="">Choose voice…</option>{ids.map(id=><option key={id} value={id}>{speakerName(run,id)} ({id})</option>)}</select>
            <button className={control} disabled={pending||!source||!target||source===target||!ids.includes(source)||!ids.includes(target)} onClick={()=>edit('merge',source,target)}>Merge voices</button>
            <button className={control} disabled={pending||!run.overlay.undo.length} onClick={()=>edit('undo')}>Undo last merge</button>
          </div>
          {!!Object.keys(run.overlay.aliases).length && <p className="text-xs text-gray-500">Merged: {Object.keys(run.overlay.aliases).map(id=>id+' → '+speakerName(run,id)).join('; ')}. Original turns and names are retained.</p>}
          <details><summary className="cursor-pointer text-sm">Speaker turns ({run.turns.length})</summary>
            <ol className="space-y-1 pt-2 text-xs">{run.turns.slice(0,limit).map((t,i)=><li key={i}><span className="font-mono text-gray-500">{formatTimestamp(t.start)}–{formatTimestamp(t.end)}</span> {speakerName(run,t.speaker)}</li>)}</ol>
            {limit<run.turns.length && <button className={control} onClick={()=>setLimit(limit+100)}>Show more turns</button>}
          </details>
        </>}
      </>}
    </div>
  </details>;
}

import {expect,test} from 'bun:test';
import React from 'react';
import {create,act,ReactTestRenderer} from 'react-test-renderer';
import {useSpeakers,SpeakerApi,SpeakerView} from '../../src/hooks/meeting-details/useSpeakers';
import {SpeakersPanel} from '../../src/components/MeetingDetails/SpeakersPanel';
import type {SpeakerRun} from '../../src/lib/speakers';
const initial=():SpeakerView=>({supported:true,ready:true,readiness:'Ready',status:{state:'',message:'',elapsed_seconds:0},snapshot:{active_id:null,runs:[]}});
test('result preview requires explicit apply and name, merge and undo controls target the selected version',async()=>{
  const run=(id:string):SpeakerRun=>({id,meeting_id:'m',created_at:'2026-10-30T12:00:00Z',audio_hash:'a',requested_speakers:2,duration:10,
    turns:[{start:0,end:5,speaker:'speaker-01'},{start:5,end:10,speaker:'speaker-02'}],overlay:{names:{},aliases:{},undo:[]}});
  const old=run('old');old.overlay.names['speaker-01']='旧名字';
  const fresh=run('new');
  const current={...initial(),snapshot:{active_id:'old',runs:[fresh,old]}};
  const edits:Record<string,unknown>[]=[];
  const api:SpeakerApi=async<T,>(command:string,args:Record<string,unknown>)=>{
    if(command==='speaker_edit'){
      edits.push(args);expect(args.meetingId).toBe('m');expect(args.runId).toBe('new');
      if(args.action==='activate')current.snapshot.active_id='new';
      if(args.action==='rename')fresh.overlay.names[String(args.speaker)]=String(args.value);
      if(args.action==='merge'){fresh.overlay.undo.push({...fresh.overlay.aliases});fresh.overlay.aliases[String(args.speaker)]=String(args.value);}
      if(args.action==='undo')fresh.overlay.aliases=fresh.overlay.undo.pop()!;
    }
    return structuredClone(current) as T;
  };
  let hook!:ReturnType<typeof useSpeakers>;
  function Harness(){hook=useSpeakers('m',api);return <SpeakersPanel controller={hook}/>;}
  let r!:ReactTestRenderer;await act(async()=>{r=create(<Harness/>);});
  const button=(name:string)=>r.root.findAllByType('button').find(b=>b.props.children===name)!;
  try {
    expect(hook.activeRun?.id).toBe('old');
    await act(async()=>r.root.findByProps({'aria-label':'Speaker result'}).props.onChange({target:{value:'new'}}));
    expect(hook.activeRun?.overlay.names['speaker-01']).toBe('旧名字');
    expect(JSON.stringify(r.toJSON())).toContain('Preview only');
    await act(async()=>button('Apply selected result').props.onClick());
    expect(hook.activeRun?.id).toBe('new');
    expect(hook.activeRun?.overlay.names).toEqual({});
    await act(async()=>r.root.findByProps({'aria-label':'Name for speaker-01'}).props.onChange({target:{value:'王老师'}}));
    await act(async()=>button('Save name').props.onClick());
    expect(hook.activeRun?.overlay.names['speaker-01']).toBe('王老师');
    await act(async()=>r.root.findByProps({'aria-label':'Merge source'}).props.onChange({target:{value:'speaker-02'}}));
    await act(async()=>r.root.findByProps({'aria-label':'Merge target'}).props.onChange({target:{value:'speaker-01'}}));
    await act(async()=>button('Merge voices').props.onClick());
    expect(hook.activeRun?.overlay.aliases['speaker-02']).toBe('speaker-01');
    await act(async()=>button('Undo last merge').props.onClick());
    expect(hook.activeRun?.overlay.aliases).toEqual({});
    expect(edits.map(e=>e.action)).toEqual(['activate','rename','merge','undo']);
  }finally{await act(async()=>r.unmount());}
});
test('a late action from a previous visit cannot unlock an action on a newer visit to the same meeting',async()=>{
  const finish:(()=>void)[]=[];
  const api:SpeakerApi=async<T,>(command:string)=>{
    if(command==='speaker_start')await new Promise<void>(resolve=>finish.push(resolve));
    return initial() as T;
  };
  let hook!:ReturnType<typeof useSpeakers>;
  function Harness({id}:{id:string}){hook=useSpeakers(id,api);return null;}
  let r!:ReactTestRenderer;
  await act(async()=>{r=create(<Harness id="a"/>);});
  try {
    await act(async()=>{void hook.act('start',{count:2});});
    await act(async()=>{r.update(<Harness id="b"/>);});
    await act(async()=>{r.update(<Harness id="a"/>);});
    await act(async()=>{void hook.act('start',{count:2});});
    expect(hook.pending).toBe(true);
    await act(async()=>finish[0]());
    expect(hook.pending).toBe(true);
    await act(async()=>finish[1]());
    expect(hook.pending).toBe(false);
  } finally {await act(async()=>r.unmount());}
});
test('participant validation, readiness, busy, cancel and errors are visible through the real panel',async()=>{
  let current=initial();let called:string[]=[];let failure=false;
  const api:SpeakerApi=async<T,>(command:string,args:Record<string,unknown>)=>{
    called.push(command);
    if(failure) throw Error('Local worker unavailable');
    if(command==='speaker_start'){expect(args.count).toBe(2);current={...current,status:{state:'running',message:'Analyzing',elapsed_seconds:1}};}
    if(command==='speaker_cancel')current={...current,status:{state:'cancelled',message:'Analysis cancelled.',elapsed_seconds:1}};
    return current as T;
  };
  let hook:ReturnType<typeof useSpeakers>;
  function Harness(){hook=useSpeakers('m',api);return <SpeakersPanel controller={hook}/>;}
  let r!:ReactTestRenderer;await act(async()=>{r=create(<Harness/>);});
  try {
    const button=(name:string)=>r.root.findAllByType('button').find(b=>b.props.children===name)!;
    expect(button('Analyze speakers')).toBeDefined();
    const count=r.root.findByProps({'aria-label':'Participant count'});
    await act(async()=>count.props.onChange({target:{value:'0'}}));
    expect(button('Analyze speakers').props.disabled).toBe(true);
    await act(async()=>count.props.onChange({target:{value:'2'}}));
    await act(async()=>button('Analyze speakers').props.onClick());
    expect(button('Analyze speakers').props.disabled).toBe(true);
    expect(button('Cancel analysis')).toBeDefined();
    await act(async()=>button('Cancel analysis').props.onClick());
    expect(JSON.stringify(r.toJSON())).toContain('Analysis cancelled.');
    current={...current,ready:false,readiness:'Missing runtime'};
    await act(async()=>hook!.refresh());
    expect(button('Analyze speakers').props.disabled).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('Missing runtime');
    current={...current,ready:true};await act(async()=>hook!.refresh());failure=true;
    await act(async()=>button('Analyze speakers').props.onClick());
    expect(JSON.stringify(r.toJSON())).toContain('Local worker unavailable');
    expect(called.filter(c=>c==='speaker_start')).toHaveLength(2);
  } finally {await act(async()=>r.unmount());}
});

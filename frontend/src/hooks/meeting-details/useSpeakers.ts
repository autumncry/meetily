import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SpeakerSnapshot } from '@/lib/speakers';
export interface SpeakerView {supported:boolean;ready:boolean;readiness:string;status:{state:string;message:string;elapsed_seconds:number};snapshot:SpeakerSnapshot}
export type SpeakerApi = <T>(command:string,args:Record<string,unknown>)=>Promise<T>;
export function useSpeakers(meetingId:string,api:SpeakerApi=invoke) {
  const [view,setView]=useState<SpeakerView|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const identity=useRef(meetingId);identity.current=meetingId;
  const generation=useRef(0);
  const sequence=useRef(0);const running=useRef(false);const mounted=useRef(true);
  const refresh=useCallback(async()=>{
    const version=++sequence.current;
    const visit=generation.current;
    try {
      const next=await api<SpeakerView>('speaker_view',{meetingId});
      if(mounted.current && identity.current===meetingId && generation.current===visit && sequence.current===version) setView(next);
    } catch(cause) {
      if(mounted.current && identity.current===meetingId && generation.current===visit && sequence.current===version) setError(String(cause));
    }
  },[meetingId,api]);
  useEffect(()=>{
    generation.current++;
    mounted.current=true;running.current=false;setView(null);setError(null);setPending(false);
    let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{await refresh();if(!disposed)timer=setTimeout(poll,1500);};
    void poll();
    return()=>{disposed=true;mounted.current=false;generation.current++;sequence.current++;clearTimeout(timer);};
  },[refresh]);
  const act=async(action:string,args:Record<string,unknown>={})=>{
    if(running.current)return;
    const visit=generation.current;
    const current=()=>mounted.current && identity.current===meetingId && generation.current===visit;
    running.current=true;setPending(true);setError(null);sequence.current++;
    try {
      if(action==='start') await api('speaker_start',{meetingId,...args});
      else if(action==='cancel') await api('speaker_cancel',{meetingId});
      else await api('speaker_edit',{meetingId,action,speaker:'',value:'',...args});
      if(current())await refresh();
    } catch(cause) {if(current())setError(String(cause));}
    finally {if(current()){running.current=false;setPending(false);}}
  };
  return {view,error,pending,refresh,act,activeRun:view?.snapshot.runs.find(r=>r.id===view.snapshot.active_id)};
}

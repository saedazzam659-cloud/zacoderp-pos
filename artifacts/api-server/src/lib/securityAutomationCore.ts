// Pure bounded in-memory monitor: deliberately has no database or enforcement dependency.
export const defaults = { enabled: true, retentionDays: 30, requestsPerMinute: 180, sequentialPages: 8, denialsPerMinute: 5, exportsPerMinute: 5 };
export type Settings = typeof defaults;
export function validateSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 6 && typeof v.enabled === "boolean" &&
    [7, 30, 90].includes(v.retentionDays as number) &&
    [["requestsPerMinute",30,10000],["sequentialPages",3,100],["denialsPerMinute",2,100],["exportsPerMinute",2,100]]
      .every(([k,min,max]) => Number.isInteger(v[k]) && Number(v[k]) >= Number(min) && Number(v[k]) <= Number(max));
}
export type MonitorEvent = { id:number; sessionId:string|null; at:string; type:"risk_summary"|"monitor_access"|"settings_changed"; riskScore:number; signals:string[]; requests:number; denials:number; exports:number };
type Session = { id:string; userId:number; companyId:number|null; loginAt:null; firstSeenAt:string; lastSeenAt:string; riskScore:number; status:"normal"|"monitoring"|"suspicious"|"high_risk"; signals:string[]; requests:number; denials:number; exports:number };
type Entry = { session:Session; seen:number; window:number; page:number|null; family:string; sequential:number; ua:boolean; emitted:number };
export class SecurityMonitor {
  settings = { ...defaults };
  readonly sessions = new Map<string, Entry>();
  readonly events: MonitorEvent[] = [];
  droppedEvents = 0;
  private sequence = 0;
  constructor(private emit: (event:MonitorEvent, session?:Session, actorId?:number) => void = () => {}) {}
  record(input:{userId:number;companyId:number|null;family:string;page:number|null;denied:boolean;exported:boolean;ua:boolean}, now=Date.now()) {
    if (!this.settings.enabled) return;
    const id = `u${input.userId}c${input.companyId ?? 0}`;
    let e = this.sessions.get(id);
    if (!e || now-e.seen > 1_800_000) {
      if (!e && this.sessions.size >= 2000) this.sessions.delete(this.sessions.keys().next().value!);
      e = { session:{id,userId:input.userId,companyId:input.companyId,loginAt:null,firstSeenAt:new Date(now).toISOString(),lastSeenAt:new Date(now).toISOString(),riskScore:0,status:"normal",signals:[],requests:0,denials:0,exports:0},seen:now,window:now,page:null,family:"",sequential:0,ua:false,emitted:-Infinity };
      this.sessions.set(id,e);
    }
    if (now-e.window >= 60_000) {
      e.window=now; e.session.requests=0; e.session.denials=0; e.session.exports=0; e.sequential=0; e.ua=false; e.page=null;
    }
    e.seen=now; e.session.lastSeenAt=new Date(now).toISOString();
    e.session.requests++; e.session.denials+=Number(input.denied); e.session.exports+=Number(input.exported);
    e.sequential = input.page !== null && e.page !== null && input.family === e.family && input.page === e.page+1 ? e.sequential+1 : 0;
    e.page=input.page; e.family=input.family; e.ua ||= input.ua;
    const s=this.settings;
    e.session.signals=[
      ...(e.session.requests>=s.requestsPerMinute?["request_rate"]:[]),
      ...(e.sequential>=s.sequentialPages?["sequential_pagination"]:[]),
      ...(e.session.denials>=s.denialsPerMinute?["permission_denials"]:[]),
      ...(e.session.exports>=s.exportsPerMinute?["export_rate"]:[]),
      ...(e.ua?["automation_ua_hint"]:[]),
    ];
    const n=e.session.signals.length;
    e.session.riskScore=Math.min(100,n*25);
    e.session.status=n>=3?"high_risk":n>=2?"suspicious":n?"monitoring":"normal";
    if (n>=2 && now-e.emitted>=60_000) {
      e.emitted=now; this.addEvent("risk_summary",e.session,now);
    }
  }
  addEvent(type:MonitorEvent["type"], session?:Session, now=Date.now(), actorId?:number) {
    const event:MonitorEvent={id:++this.sequence,sessionId:session?.id??null,at:new Date(now).toISOString(),type,riskScore:session?.riskScore??0,signals:[...(session?.signals??[])],requests:session?.requests??0,denials:session?.denials??0,exports:session?.exports??0};
    if(this.events.length>=500) this.events.shift();
    this.events.push(event); this.emit(event,session,actorId);
  }
  sweep(now=Date.now()) {
    for(const [id,e] of this.sessions) {
      if(now-e.seen>1_800_000) this.sessions.delete(id);
      else if(now-e.window>=60_000) {
        e.session.requests=0;e.session.denials=0;e.session.exports=0;e.session.signals=[];e.session.riskScore=0;e.session.status="normal";
      }
    }
  }
  snapshot(now=Date.now()) {
    this.sweep(now);
    const all=[...this.sessions.values()].map(e=>({...e.session,signals:[...e.session.signals]}));
    return {stats:{activeSessions:all.length,suspiciousSessions:all.filter(s=>s.status==="suspicious").length,highRiskSessions:all.filter(s=>s.status==="high_risk").length,requests:all.reduce((n,s)=>n+s.requests,0),denials:all.reduce((n,s)=>n+s.denials,0),exports:all.reduce((n,s)=>n+s.exports,0),events:this.events.length,droppedEvents:this.droppedEvents},sessions:all.sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0,100),events:this.events.slice(-100).reverse()};
  }
}
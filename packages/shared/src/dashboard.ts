/** Versioned dashboard contract. Counts refer to the authenticated role and workflow only. */
export type DashboardWindow = '24h' | '7d' | '30d';
export type DashboardMetric = { value:number|null; unit:string; href:string; series:number[]; measured:number; note:string };
export type DashboardBucket = { at:string; count:number; topics:Record<string,number>; href:string };
export type DashboardSignal = { id:string; title:string; topic:string; brand:string; level:'h'|'m'|'l'; count:number; sources:number; spread:number; action:'none'|'investigating'|'responding'|'resolved'; href:string; evidence:Array<{id:string;url:string;quote:string;published_at:string|null}>; reason:string };
export type DashboardResponse = {
 version:1; aggregate_updated_at?:string|null; workflow_id:string; window:DashboardWindow; start:string; end:string; timezone:'Europe/Kyiv'; generated_at:string; aggregated:boolean;
 visibility:'accepted'|'accepted_review';
 brand_status:{level:'calm'|'attention'|'critical'|'unknown';title:string;reason:string;negative_delta_pp:number|null;href:string};
 metrics:{mentions:DashboardMetric;critical:DashboardMetric;negative_share:DashboardMetric;negative_reach:DashboardMetric;collection_lag:DashboardMetric;noise?:DashboardMetric};
 counts:{accepted:number;review?:number;collected?:number;rejected?:number;pending?:number};
 hourly:DashboardBucket[];
 topics:Array<{topic:string;count:number;href:string}>;
 sources:Array<{id:string;title:string;kind:string;count:number;href:string}>;
 reactions:{negative:number;ironic:number;sad:number;positive:number;total:number;observed_items:number;negative_share:number|null;href:string;note:string};
 signals:DashboardSignal[];
 spread:Array<{id:string;count:number;source_count:number;third_repost_seconds:number|null;items_per_hour_first_6h:number;href:string}>;
 reach_anomalies:Array<{id:string;views:number;baseline:number;ratio:number;href:string}>;
 growth:Array<{id:string;views_per_hour:number;observations:number;href:string}>;
 complaints:{count:number;per_hour:number;href:string;note:string};
 lag_by_service:Array<{service:string;median_seconds:number|null;measured:number;href:string}>;
 freshness:Array<{service:string;enabled:boolean;last_success_at:string|null;heartbeat_at:string|null}>;
 competitors:Array<{brand:string;count:number;negative:number;href:string}>;
 ai:{status:'waiting_key'|'rules';label:string;summary:string;href:string};
 methodology:string[];
};

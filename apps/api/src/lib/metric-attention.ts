/** Display thresholds chosen for this demo, not calibrated crisis probabilities. */
export function reactionAttention(share:number|null,total:number,items:number) {
  if(share===null||total<20||items<3)return 0;
  return share>=.75?3:share>=.5?2:share>=.25?1:0;
}
export function criticalAttention(count:number|null) {
  return count===null||count===0?0:count>=5?3:count>=3?2:1;
}

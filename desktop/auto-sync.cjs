'use strict';
const {normalizeConfig}=require('../core/dav.cjs');

// Editing only queues local changes. This timer is the sole automatic trigger.
class AutoSync{
  constructor(sync,clock=globalThis){this.sync=sync;this.clock=clock;this.timer=null;}
  configure(raw){
    const config=normalizeConfig(raw);
    this.stop();
    if(config.auto&&(config.primary||config.secondary)){
      this.timer=this.clock.setInterval(()=>{
        if(!this.sync.running)this.sync.run({...config}).catch(()=>{});
      },config.syncIntervalMinutes*60000);
    }
  }
  stop(){if(this.timer!==null)this.clock.clearInterval(this.timer);this.timer=null;}
}
module.exports={AutoSync};

import {deflateSync,inflateSync} from 'fflate';
import {Buffer} from 'buffer';
const adapter={deflateRawSync:(buf,options={})=>Buffer.from(deflateSync(buf,{level:options.level||5})),inflateRawSync:(buf,options={})=>{const bytes=inflateSync(buf);if(options.maxOutputLength&&bytes.length>options.maxOutputLength)throw Error('ZIP entry exceeds capacity');return Buffer.from(bytes);}};
export default adapter;
export const {deflateRawSync,inflateRawSync}=adapter;

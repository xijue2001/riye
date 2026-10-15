import {sha256} from '@noble/hashes/sha2.js';
import {Buffer} from 'buffer';
const adapter={
 randomUUID:()=>globalThis.crypto.randomUUID(),
 createHash:name=>{if(name!=='sha256')throw Error('Unsupported digest');const hash=sha256.create();const result={update:bytes=>{hash.update(Buffer.from(bytes));return result;},digest:format=>{const b=Buffer.from(hash.digest());return format?b.toString(format):b;}};return result;}
};
export default adapter;
export const {randomUUID,createHash}=adapter;

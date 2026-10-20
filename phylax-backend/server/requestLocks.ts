import type {Request} from "express";
/** Release only after handler work settles, including client disconnects. */
export const requestLocks=new WeakMap<Request,()=>Promise<void>>();

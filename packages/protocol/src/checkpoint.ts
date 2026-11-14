export interface CheckpointFile { path:string; content:string; sha256:string; mode?:number }
export interface ThreadCheckpoint { version:1; threadId:string; runtimeVersion:string; createdAt:string; files:CheckpointFile[]; omittedPaths?:string[] }
export interface CheckpointReference { threadId:string; sha256:string; bytes:number; createdAt:string; runtimeVersion:string; omittedPaths?:string[] }

import type { PermissionMode } from "./permissions.js";
import type { RuntimeModel, WorkerRecord } from "./control.js";
export interface OwnerOnboarding {ownerId:string;primaryMowerId:string;primaryThreadId:string;profileId:string;profileVersion:number;revision:number;createdAt:string;updatedAt:string}
export interface OnboardingStatus {setup?:OwnerOnboarding;models:RuntimeModel[];workers:WorkerRecord[]}
export interface CreateOnboarding {requestId:string;name:string;title:string;model:string;workerId:string;mode:PermissionMode;workspaceWrite:"ask"|"allow";processExecute:"ask"|"deny";delegation:"ask"|"deny"}
export interface SelectPrimaryDirector {requestId:string;mowerId:string;threadId:string;expectedRevision?:number}
export interface OnboardingResult {setup:OwnerOnboarding;created:boolean}

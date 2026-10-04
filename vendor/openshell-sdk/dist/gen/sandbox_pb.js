// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { enumDesc, fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
import { file_google_protobuf_duration, file_google_protobuf_struct } from "@bufbuild/protobuf/wkt";
import { file_datamodel } from "./datamodel_pb.js";
/**
 * Describes the file sandbox.proto.
 */
export const file_sandbox = /*@__PURE__*/ fileDesc("Cg1zYW5kYm94LnByb3RvEhRvcGVuc2hlbGwuc2FuZGJveC52MSLDBAoNU2FuZGJveFBvbGljeRIPCgd2ZXJzaW9uGAEgASgNEjoKCmZpbGVzeXN0ZW0YAiABKAsyJi5vcGVuc2hlbGwuc2FuZGJveC52MS5GaWxlc3lzdGVtUG9saWN5EjYKCGxhbmRsb2NrGAMgASgLMiQub3BlbnNoZWxsLnNhbmRib3gudjEuTGFuZGxvY2tQb2xpY3kSNAoHcHJvY2VzcxgEIAEoCzIjLm9wZW5zaGVsbC5zYW5kYm94LnYxLlByb2Nlc3NQb2xpY3kSUgoQbmV0d29ya19wb2xpY2llcxgFIAMoCzI4Lm9wZW5zaGVsbC5zYW5kYm94LnYxLlNhbmRib3hQb2xpY3kuTmV0d29ya1BvbGljaWVzRW50cnkSWAoTbmV0d29ya19taWRkbGV3YXJlcxgGIAMoCzI7Lm9wZW5zaGVsbC5zYW5kYm94LnYxLlNhbmRib3hQb2xpY3kuTmV0d29ya01pZGRsZXdhcmVzRW50cnkaXwoUTmV0d29ya1BvbGljaWVzRW50cnkSCwoDa2V5GAEgASgJEjYKBXZhbHVlGAIgASgLMicub3BlbnNoZWxsLnNhbmRib3gudjEuTmV0d29ya1BvbGljeVJ1bGU6AjgBGmgKF05ldHdvcmtNaWRkbGV3YXJlc0VudHJ5EgsKA2tleRgBIAEoCRI8CgV2YWx1ZRgCIAEoCzItLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtNaWRkbGV3YXJlQ29uZmlnOgI4ASJSChBGaWxlc3lzdGVtUG9saWN5EhcKD2luY2x1ZGVfd29ya2RpchgBIAEoCBIRCglyZWFkX29ubHkYAiADKAkSEgoKcmVhZF93cml0ZRgDIAMoCSInCg5MYW5kbG9ja1BvbGljeRIVCg1jb21wYXRpYmlsaXR5GAEgASgJIjoKDVByb2Nlc3NQb2xpY3kSEwoLcnVuX2FzX3VzZXIYASABKAkSFAoMcnVuX2FzX2dyb3VwGAIgASgJIpIBChFOZXR3b3JrUG9saWN5UnVsZRIMCgRuYW1lGAEgASgJEjgKCWVuZHBvaW50cxgCIAMoCzIlLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtFbmRwb2ludBI1CghiaW5hcmllcxgDIAMoCzIjLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtCaW5hcnkiygEKF05ldHdvcmtNaWRkbGV3YXJlQ29uZmlnEgwKBG5hbWUYASABKAkSEgoKbWlkZGxld2FyZRgCIAEoCRInCgZjb25maWcYAyABKAsyFy5nb29nbGUucHJvdG9idWYuU3RydWN0EhAKCG9uX2Vycm9yGAQgASgJEkMKCWVuZHBvaW50cxgFIAEoCzIwLm9wZW5zaGVsbC5zYW5kYm94LnYxLk1pZGRsZXdhcmVFbmRwb2ludFNlbGVjdG9yEg0KBW9yZGVyGAYgASgFIj4KGk1pZGRsZXdhcmVFbmRwb2ludFNlbGVjdG9yEg8KB2luY2x1ZGUYASADKAkSDwoHZXhjbHVkZRgCIAMoCSIsChhOZXR3b3JrQ3JlZGVudGlhbEJpbmRpbmcSEAoIcHJvdmlkZXIYASABKAkixAgKD05ldHdvcmtFbmRwb2ludBIMCgRob3N0GAEgASgJEgwKBHBvcnQYAiABKA0SEAoIcHJvdG9jb2wYAyABKAkSMQoDdGxzGAQgASgOMiQub3BlbnNoZWxsLnNhbmRib3gudjEuTmV0d29ya1Rsc01vZGUSQQoLZW5mb3JjZW1lbnQYBSABKA4yLC5vcGVuc2hlbGwuc2FuZGJveC52MS5OZXR3b3JrRW5mb3JjZW1lbnRNb2RlEjkKBmFjY2VzcxgGIAEoDjIpLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtBY2Nlc3NQcmVzZXQSKwoFcnVsZXMYByADKAsyHC5vcGVuc2hlbGwuc2FuZGJveC52MS5MN1J1bGUSEwoLYWxsb3dlZF9pcHMYCCADKAkSDQoFcG9ydHMYCSADKA0SNAoKZGVueV9ydWxlcxgKIAMoCzIgLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3RGVueVJ1bGUSGwoTYWxsb3dfZW5jb2RlZF9zbGFzaBgLIAEoCBIZChFwZXJzaXN0ZWRfcXVlcmllcxgMIAEoCRJlChlncmFwaHFsX3BlcnNpc3RlZF9xdWVyaWVzGA0gAygLMkIub3BlbnNoZWxsLnNhbmRib3gudjEuTmV0d29ya0VuZHBvaW50LkdyYXBocWxQZXJzaXN0ZWRRdWVyaWVzRW50cnkSHgoWZ3JhcGhxbF9tYXhfYm9keV9ieXRlcxgOIAEoDRIMCgRwYXRoGA8gASgJEiQKHHdlYnNvY2tldF9jcmVkZW50aWFsX3Jld3JpdGUYECABKAgSJwofcmVxdWVzdF9ib2R5X2NyZWRlbnRpYWxfcmV3cml0ZRgRIAEoCBIYChBhZHZpc29yX3Byb3Bvc2VkGBIgASgIEhoKEmNyZWRlbnRpYWxfc2lnbmluZxgTIAEoCRIXCg9zaWduaW5nX3NlcnZpY2UYFCABKAkSFgoOc2lnbmluZ19yZWdpb24YFSABKAkSHwoXanNvbl9ycGNfbWF4X2JvZHlfYnl0ZXMYFiABKA0SLQoDbWNwGBcgASgLMiAub3BlbnNoZWxsLnNhbmRib3gudjEuTWNwT3B0aW9ucxJKChJjcmVkZW50aWFsX2JpbmRpbmcYGCABKAsyLi5vcGVuc2hlbGwuc2FuZGJveC52MS5OZXR3b3JrQ3JlZGVudGlhbEJpbmRpbmcSJQodYWxsb3dfdW5pbnNwZWN0ZWRfY3JlZGVudGlhbHMYGSABKAgSHQoVcHJvdmlkZXJfY3JlZGVudGlhbGVkGBogASgIGmYKHEdyYXBocWxQZXJzaXN0ZWRRdWVyaWVzRW50cnkSCwoDa2V5GAEgASgJEjUKBXZhbHVlGAIgASgLMiYub3BlbnNoZWxsLnNhbmRib3gudjEuR3JhcGhxbE9wZXJhdGlvbjoCOAEingEKCk1jcE9wdGlvbnMSHgoRc3RyaWN0X3Rvb2xfbmFtZXMYASABKAhIAIgBARIoChthbGxvd19hbGxfa25vd25fbWNwX21ldGhvZHMYAiABKAhIAYgBARIQCgh2ZXJzaW9ucxgDIAMoCUIUChJfc3RyaWN0X3Rvb2xfbmFtZXNCHgocX2FsbG93X2FsbF9rbm93bl9tY3BfbWV0aG9kcyJSChBHcmFwaHFsT3BlcmF0aW9uEhYKDm9wZXJhdGlvbl90eXBlGAEgASgJEhYKDm9wZXJhdGlvbl9uYW1lGAIgASgJEg4KBmZpZWxkcxgDIAMoCSKkAwoKTDdEZW55UnVsZRIOCgZtZXRob2QYASABKAkSDAoEcGF0aBgCIAEoCRIPCgdjb21tYW5kGAMgASgJEjoKBXF1ZXJ5GAQgAygLMisub3BlbnNoZWxsLnNhbmRib3gudjEuTDdEZW55UnVsZS5RdWVyeUVudHJ5EhYKDm9wZXJhdGlvbl90eXBlGAUgASgJEhYKDm9wZXJhdGlvbl9uYW1lGAYgASgJEg4KBmZpZWxkcxgHIAMoCRI8CgZwYXJhbXMYCSADKAsyLC5vcGVuc2hlbGwuc2FuZGJveC52MS5MN0RlbnlSdWxlLlBhcmFtc0VudHJ5GlIKClF1ZXJ5RW50cnkSCwoDa2V5GAEgASgJEjMKBXZhbHVlGAIgASgLMiQub3BlbnNoZWxsLnNhbmRib3gudjEuTDdRdWVyeU1hdGNoZXI6AjgBGlMKC1BhcmFtc0VudHJ5EgsKA2tleRgBIAEoCRIzCgV2YWx1ZRgCIAEoCzIkLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3UXVlcnlNYXRjaGVyOgI4AUoECAgQCSI2CgZMN1J1bGUSLAoFYWxsb3cYASABKAsyHS5vcGVuc2hlbGwuc2FuZGJveC52MS5MN0FsbG93IpsDCgdMN0FsbG93Eg4KBm1ldGhvZBgBIAEoCRIMCgRwYXRoGAIgASgJEg8KB2NvbW1hbmQYAyABKAkSNwoFcXVlcnkYBCADKAsyKC5vcGVuc2hlbGwuc2FuZGJveC52MS5MN0FsbG93LlF1ZXJ5RW50cnkSFgoOb3BlcmF0aW9uX3R5cGUYBSABKAkSFgoOb3BlcmF0aW9uX25hbWUYBiABKAkSDgoGZmllbGRzGAcgAygJEjkKBnBhcmFtcxgJIAMoCzIpLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3QWxsb3cuUGFyYW1zRW50cnkaUgoKUXVlcnlFbnRyeRILCgNrZXkYASABKAkSMwoFdmFsdWUYAiABKAsyJC5vcGVuc2hlbGwuc2FuZGJveC52MS5MN1F1ZXJ5TWF0Y2hlcjoCOAEaUwoLUGFyYW1zRW50cnkSCwoDa2V5GAEgASgJEjMKBXZhbHVlGAIgASgLMiQub3BlbnNoZWxsLnNhbmRib3gudjEuTDdRdWVyeU1hdGNoZXI6AjgBSgQICBAJIisKDkw3UXVlcnlNYXRjaGVyEgwKBGdsb2IYASABKAkSCwoDYW55GAIgAygJIiwKDU5ldHdvcmtCaW5hcnkSDAoEcGF0aBgBIAEoCUoECAIQA1IHaGFybmVzcyJrChdHZXRTYW5kYm94Q29uZmlnUmVxdWVzdBJCCg93b3Jrc3BhY2Vfc2NvcGUYAyABKAsyKS5vcGVuc2hlbGwuZGF0YW1vZGVsLnYxLldvcmtzcGFjZVNlbGVjdG9yEgwKBG5hbWUYASABKAkiGQoXR2V0R2F0ZXdheUNvbmZpZ1JlcXVlc3Qi2gEKGEdldEdhdGV3YXlDb25maWdSZXNwb25zZRJOCghzZXR0aW5ncxgBIAMoCzI8Lm9wZW5zaGVsbC5zYW5kYm94LnYxLkdldEdhdGV3YXlDb25maWdSZXNwb25zZS5TZXR0aW5nc0VudHJ5EhkKEXNldHRpbmdzX3JldmlzaW9uGAIgASgEGlMKDVNldHRpbmdzRW50cnkSCwoDa2V5GAEgASgJEjEKBXZhbHVlGAIgASgLMiIub3BlbnNoZWxsLnNhbmRib3gudjEuU2V0dGluZ1ZhbHVlOgI4ASJxCgxTZXR0aW5nVmFsdWUSFgoMc3RyaW5nX3ZhbHVlGAEgASgJSAASFAoKYm9vbF92YWx1ZRgCIAEoCEgAEhMKCWludF92YWx1ZRgDIAEoA0gAEhUKC2J5dGVzX3ZhbHVlGAQgASgMSABCBwoFdmFsdWUieAoQRWZmZWN0aXZlU2V0dGluZxIxCgV2YWx1ZRgBIAEoCzIiLm9wZW5zaGVsbC5zYW5kYm94LnYxLlNldHRpbmdWYWx1ZRIxCgVzY29wZRgCIAEoDjIiLm9wZW5zaGVsbC5zYW5kYm94LnYxLlNldHRpbmdTY29wZSLzBQoYR2V0U2FuZGJveENvbmZpZ1Jlc3BvbnNlEjMKBnBvbGljeRgBIAEoCzIjLm9wZW5zaGVsbC5zYW5kYm94LnYxLlNhbmRib3hQb2xpY3kSDwoHdmVyc2lvbhgCIAEoDRITCgtwb2xpY3lfaGFzaBgDIAEoCRJOCghzZXR0aW5ncxgEIAMoCzI8Lm9wZW5zaGVsbC5zYW5kYm94LnYxLkdldFNhbmRib3hDb25maWdSZXNwb25zZS5TZXR0aW5nc0VudHJ5EhcKD2NvbmZpZ19yZXZpc2lvbhgFIAEoBBI5Cg1wb2xpY3lfc291cmNlGAYgASgOMiIub3BlbnNoZWxsLnNhbmRib3gudjEuUG9saWN5U291cmNlEh0KFWdsb2JhbF9wb2xpY3lfdmVyc2lvbhgHIAEoDRIdChVwcm92aWRlcl9lbnZfcmV2aXNpb24YCCABKAQSWQoec3VwZXJ2aXNvcl9taWRkbGV3YXJlX3NlcnZpY2VzGAkgAygLMjEub3BlbnNoZWxsLnNhbmRib3gudjEuU3VwZXJ2aXNvck1pZGRsZXdhcmVTZXJ2aWNlEhEKCXdvcmtzcGFjZRgKIAEoCRImCh5wb2xpY3lfdmFsaWRhdGlvbl9mYWlsdXJlX21vZGUYCyABKAkSKAogZXh0ZW5zaW9uX2F1dGhlbnRpY2F0aW9uX2VuYWJsZWQYDCABKAgSIQoZcHJvdmlkZXJfYXR0YWNobWVudF9lcG9jaBgOIAEoCRIeChZjb25maWd1cmF0aW9uX2FkbWl0dGVkGA0gASgIEhsKE2NvbmZpZ3VyYXRpb25fZXJyb3IYECABKAkSIQoZY29uZmlndXJhdGlvbl9pbnN0YW5jZV9pZBgPIAEoCRpXCg1TZXR0aW5nc0VudHJ5EgsKA2tleRgBIAEoCRI1CgV2YWx1ZRgCIAEoCzImLm9wZW5zaGVsbC5zYW5kYm94LnYxLkVmZmVjdGl2ZVNldHRpbmc6AjgBIu0BChtTdXBlcnZpc29yTWlkZGxld2FyZVNlcnZpY2USDAoEbmFtZRgBIAEoCRIVCg1ncnBjX2VuZHBvaW50GAIgASgJEhkKEW1heF9wYXlsb2FkX2J5dGVzGAMgASgEEjIKD3JlcXVlc3RfdGltZW91dBhoIAEoCzIZLmdvb2dsZS5wcm90b2J1Zi5EdXJhdGlvbhIXCg90bHNfY2FfY2VydF9wZW0YBSABKAwSEAoIYXVkaWVuY2UYBiABKAkSIAoYYWxsb3dfaW5zZWN1cmVfdHJhbnNwb3J0GAcgASgISgQIBBAFUgd0aW1lb3V0KpcBCg5OZXR3b3JrVGxzTW9kZRIgChxORVRXT1JLX1RMU19NT0RFX1VOU1BFQ0lGSUVEEAASGQoVTkVUV09SS19UTFNfTU9ERV9TS0lQEAESIgoaTkVUV09SS19UTFNfTU9ERV9URVJNSU5BVEUQAhoCCAESJAocTkVUV09SS19UTFNfTU9ERV9QQVNTVEhST1VHSBADGgIIASqMAQoWTmV0d29ya0VuZm9yY2VtZW50TW9kZRIoCiRORVRXT1JLX0VORk9SQ0VNRU5UX01PREVfVU5TUEVDSUZJRUQQABIkCiBORVRXT1JLX0VORk9SQ0VNRU5UX01PREVfRU5GT1JDRRABEiIKHk5FVFdPUktfRU5GT1JDRU1FTlRfTU9ERV9BVURJVBACKqcBChNOZXR3b3JrQWNjZXNzUHJlc2V0EiUKIU5FVFdPUktfQUNDRVNTX1BSRVNFVF9VTlNQRUNJRklFRBAAEiMKH05FVFdPUktfQUNDRVNTX1BSRVNFVF9SRUFEX09OTFkQARIkCiBORVRXT1JLX0FDQ0VTU19QUkVTRVRfUkVBRF9XUklURRACEh4KGk5FVFdPUktfQUNDRVNTX1BSRVNFVF9GVUxMEAMqYgoMU2V0dGluZ1Njb3BlEh0KGVNFVFRJTkdfU0NPUEVfVU5TUEVDSUZJRUQQABIZChVTRVRUSU5HX1NDT1BFX1NBTkRCT1gQARIYChRTRVRUSU5HX1NDT1BFX0dMT0JBTBACKmIKDFBvbGljeVNvdXJjZRIdChlQT0xJQ1lfU09VUkNFX1VOU1BFQ0lGSUVEEAASGQoVUE9MSUNZX1NPVVJDRV9TQU5EQk9YEAESGAoUUE9MSUNZX1NPVVJDRV9HTE9CQUwQAmIGcHJvdG8z", [file_google_protobuf_struct, file_google_protobuf_duration, file_datamodel]);
/**
 * Describes the message openshell.sandbox.v1.SandboxPolicy.
 * Use `create(SandboxPolicySchema)` to create a new message.
 */
export const SandboxPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 0);
/**
 * Describes the message openshell.sandbox.v1.FilesystemPolicy.
 * Use `create(FilesystemPolicySchema)` to create a new message.
 */
export const FilesystemPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 1);
/**
 * Describes the message openshell.sandbox.v1.LandlockPolicy.
 * Use `create(LandlockPolicySchema)` to create a new message.
 */
export const LandlockPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 2);
/**
 * Describes the message openshell.sandbox.v1.ProcessPolicy.
 * Use `create(ProcessPolicySchema)` to create a new message.
 */
export const ProcessPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 3);
/**
 * Describes the message openshell.sandbox.v1.NetworkPolicyRule.
 * Use `create(NetworkPolicyRuleSchema)` to create a new message.
 */
export const NetworkPolicyRuleSchema = /*@__PURE__*/ messageDesc(file_sandbox, 4);
/**
 * Describes the message openshell.sandbox.v1.NetworkMiddlewareConfig.
 * Use `create(NetworkMiddlewareConfigSchema)` to create a new message.
 */
export const NetworkMiddlewareConfigSchema = /*@__PURE__*/ messageDesc(file_sandbox, 5);
/**
 * Describes the message openshell.sandbox.v1.MiddlewareEndpointSelector.
 * Use `create(MiddlewareEndpointSelectorSchema)` to create a new message.
 */
export const MiddlewareEndpointSelectorSchema = /*@__PURE__*/ messageDesc(file_sandbox, 6);
/**
 * Describes the message openshell.sandbox.v1.NetworkCredentialBinding.
 * Use `create(NetworkCredentialBindingSchema)` to create a new message.
 */
export const NetworkCredentialBindingSchema = /*@__PURE__*/ messageDesc(file_sandbox, 7);
/**
 * Describes the message openshell.sandbox.v1.NetworkEndpoint.
 * Use `create(NetworkEndpointSchema)` to create a new message.
 */
export const NetworkEndpointSchema = /*@__PURE__*/ messageDesc(file_sandbox, 8);
/**
 * Describes the message openshell.sandbox.v1.McpOptions.
 * Use `create(McpOptionsSchema)` to create a new message.
 */
export const McpOptionsSchema = /*@__PURE__*/ messageDesc(file_sandbox, 9);
/**
 * Describes the message openshell.sandbox.v1.GraphqlOperation.
 * Use `create(GraphqlOperationSchema)` to create a new message.
 */
export const GraphqlOperationSchema = /*@__PURE__*/ messageDesc(file_sandbox, 10);
/**
 * Describes the message openshell.sandbox.v1.L7DenyRule.
 * Use `create(L7DenyRuleSchema)` to create a new message.
 */
export const L7DenyRuleSchema = /*@__PURE__*/ messageDesc(file_sandbox, 11);
/**
 * Describes the message openshell.sandbox.v1.L7Rule.
 * Use `create(L7RuleSchema)` to create a new message.
 */
export const L7RuleSchema = /*@__PURE__*/ messageDesc(file_sandbox, 12);
/**
 * Describes the message openshell.sandbox.v1.L7Allow.
 * Use `create(L7AllowSchema)` to create a new message.
 */
export const L7AllowSchema = /*@__PURE__*/ messageDesc(file_sandbox, 13);
/**
 * Describes the message openshell.sandbox.v1.L7QueryMatcher.
 * Use `create(L7QueryMatcherSchema)` to create a new message.
 */
export const L7QueryMatcherSchema = /*@__PURE__*/ messageDesc(file_sandbox, 14);
/**
 * Describes the message openshell.sandbox.v1.NetworkBinary.
 * Use `create(NetworkBinarySchema)` to create a new message.
 */
export const NetworkBinarySchema = /*@__PURE__*/ messageDesc(file_sandbox, 15);
/**
 * Describes the message openshell.sandbox.v1.GetSandboxConfigRequest.
 * Use `create(GetSandboxConfigRequestSchema)` to create a new message.
 */
export const GetSandboxConfigRequestSchema = /*@__PURE__*/ messageDesc(file_sandbox, 16);
/**
 * Describes the message openshell.sandbox.v1.GetGatewayConfigRequest.
 * Use `create(GetGatewayConfigRequestSchema)` to create a new message.
 */
export const GetGatewayConfigRequestSchema = /*@__PURE__*/ messageDesc(file_sandbox, 17);
/**
 * Describes the message openshell.sandbox.v1.GetGatewayConfigResponse.
 * Use `create(GetGatewayConfigResponseSchema)` to create a new message.
 */
export const GetGatewayConfigResponseSchema = /*@__PURE__*/ messageDesc(file_sandbox, 18);
/**
 * Describes the message openshell.sandbox.v1.SettingValue.
 * Use `create(SettingValueSchema)` to create a new message.
 */
export const SettingValueSchema = /*@__PURE__*/ messageDesc(file_sandbox, 19);
/**
 * Describes the message openshell.sandbox.v1.EffectiveSetting.
 * Use `create(EffectiveSettingSchema)` to create a new message.
 */
export const EffectiveSettingSchema = /*@__PURE__*/ messageDesc(file_sandbox, 20);
/**
 * Describes the message openshell.sandbox.v1.GetSandboxConfigResponse.
 * Use `create(GetSandboxConfigResponseSchema)` to create a new message.
 */
export const GetSandboxConfigResponseSchema = /*@__PURE__*/ messageDesc(file_sandbox, 21);
/**
 * Describes the message openshell.sandbox.v1.SupervisorMiddlewareService.
 * Use `create(SupervisorMiddlewareServiceSchema)` to create a new message.
 */
export const SupervisorMiddlewareServiceSchema = /*@__PURE__*/ messageDesc(file_sandbox, 22);
/**
 * TLS handling for a network endpoint.
 *
 * @generated from enum openshell.sandbox.v1.NetworkTlsMode
 */
export var NetworkTlsMode;
(function (NetworkTlsMode) {
    /**
     * Auto-detect TLS and terminate it when inspection is configured.
     *
     * @generated from enum value: NETWORK_TLS_MODE_UNSPECIFIED = 0;
     */
    NetworkTlsMode[NetworkTlsMode["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * Disable TLS detection and relay the connection without inspection.
     *
     * @generated from enum value: NETWORK_TLS_MODE_SKIP = 1;
     */
    NetworkTlsMode[NetworkTlsMode["SKIP"] = 1] = "SKIP";
    /**
     * Rejected by policy validation; use NETWORK_TLS_MODE_UNSPECIFIED.
     *
     * @generated from enum value: NETWORK_TLS_MODE_TERMINATE = 2 [deprecated = true];
     * @deprecated
     */
    NetworkTlsMode[NetworkTlsMode["TERMINATE"] = 2] = "TERMINATE";
    /**
     * Rejected by policy validation; use NETWORK_TLS_MODE_UNSPECIFIED.
     *
     * @generated from enum value: NETWORK_TLS_MODE_PASSTHROUGH = 3 [deprecated = true];
     * @deprecated
     */
    NetworkTlsMode[NetworkTlsMode["PASSTHROUGH"] = 3] = "PASSTHROUGH";
})(NetworkTlsMode || (NetworkTlsMode = {}));
/**
 * Describes the enum openshell.sandbox.v1.NetworkTlsMode.
 */
export const NetworkTlsModeSchema = /*@__PURE__*/ enumDesc(file_sandbox, 0);
/**
 * Enforcement behavior for inspected network traffic.
 *
 * @generated from enum openshell.sandbox.v1.NetworkEnforcementMode
 */
export var NetworkEnforcementMode;
(function (NetworkEnforcementMode) {
    /**
     * Preserve the existing default: log violations and allow traffic.
     *
     * @generated from enum value: NETWORK_ENFORCEMENT_MODE_UNSPECIFIED = 0;
     */
    NetworkEnforcementMode[NetworkEnforcementMode["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * Deny traffic that does not satisfy the endpoint policy.
     *
     * @generated from enum value: NETWORK_ENFORCEMENT_MODE_ENFORCE = 1;
     */
    NetworkEnforcementMode[NetworkEnforcementMode["ENFORCE"] = 1] = "ENFORCE";
    /**
     * Log policy violations and allow the traffic.
     *
     * @generated from enum value: NETWORK_ENFORCEMENT_MODE_AUDIT = 2;
     */
    NetworkEnforcementMode[NetworkEnforcementMode["AUDIT"] = 2] = "AUDIT";
})(NetworkEnforcementMode || (NetworkEnforcementMode = {}));
/**
 * Describes the enum openshell.sandbox.v1.NetworkEnforcementMode.
 */
export const NetworkEnforcementModeSchema = /*@__PURE__*/ enumDesc(file_sandbox, 1);
/**
 * Shorthand access policy for an inspected network endpoint.
 *
 * @generated from enum openshell.sandbox.v1.NetworkAccessPreset
 */
export var NetworkAccessPreset;
(function (NetworkAccessPreset) {
    /**
     * No access preset; explicit rules may define allowed traffic.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_UNSPECIFIED = 0;
     */
    NetworkAccessPreset[NetworkAccessPreset["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * Allow read-only operations for the selected protocol.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_READ_ONLY = 1;
     */
    NetworkAccessPreset[NetworkAccessPreset["READ_ONLY"] = 1] = "READ_ONLY";
    /**
     * Allow read and write operations for the selected protocol.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_READ_WRITE = 2;
     */
    NetworkAccessPreset[NetworkAccessPreset["READ_WRITE"] = 2] = "READ_WRITE";
    /**
     * Allow every operation supported by the selected protocol.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_FULL = 3;
     */
    NetworkAccessPreset[NetworkAccessPreset["FULL"] = 3] = "FULL";
})(NetworkAccessPreset || (NetworkAccessPreset = {}));
/**
 * Describes the enum openshell.sandbox.v1.NetworkAccessPreset.
 */
export const NetworkAccessPresetSchema = /*@__PURE__*/ enumDesc(file_sandbox, 2);
/**
 * Scope that currently controls a setting.
 *
 * @generated from enum openshell.sandbox.v1.SettingScope
 */
export var SettingScope;
(function (SettingScope) {
    /**
     * @generated from enum value: SETTING_SCOPE_UNSPECIFIED = 0;
     */
    SettingScope[SettingScope["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * @generated from enum value: SETTING_SCOPE_SANDBOX = 1;
     */
    SettingScope[SettingScope["SANDBOX"] = 1] = "SANDBOX";
    /**
     * @generated from enum value: SETTING_SCOPE_GLOBAL = 2;
     */
    SettingScope[SettingScope["GLOBAL"] = 2] = "GLOBAL";
})(SettingScope || (SettingScope = {}));
/**
 * Describes the enum openshell.sandbox.v1.SettingScope.
 */
export const SettingScopeSchema = /*@__PURE__*/ enumDesc(file_sandbox, 3);
/**
 * Source used for the policy payload in GetSandboxConfigResponse.
 *
 * @generated from enum openshell.sandbox.v1.PolicySource
 */
export var PolicySource;
(function (PolicySource) {
    /**
     * @generated from enum value: POLICY_SOURCE_UNSPECIFIED = 0;
     */
    PolicySource[PolicySource["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * @generated from enum value: POLICY_SOURCE_SANDBOX = 1;
     */
    PolicySource[PolicySource["SANDBOX"] = 1] = "SANDBOX";
    /**
     * @generated from enum value: POLICY_SOURCE_GLOBAL = 2;
     */
    PolicySource[PolicySource["GLOBAL"] = 2] = "GLOBAL";
})(PolicySource || (PolicySource = {}));
/**
 * Describes the enum openshell.sandbox.v1.PolicySource.
 */
export const PolicySourceSchema = /*@__PURE__*/ enumDesc(file_sandbox, 4);
//# sourceMappingURL=sandbox_pb.js.map